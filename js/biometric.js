// ---------------------------------------------------------------------------
//  Quick unlock — Face ID / Touch ID / fingerprint (WebAuthn passkey)
// ---------------------------------------------------------------------------
//  Why this exists: on mobile the app deliberately drops its Supabase session
//  the moment it's closed (see supabaseClient.js — the session lives in
//  sessionStorage, which the OS wipes when the app or tab goes away). That's
//  good for a phone that gets left on a truck tailgate, but retyping a password
//  every time you walk up to a hive is miserable.
//
//  So we keep ONE thing behind the device's own biometric gate: the Supabase
//  refresh token. Unlocking asks the platform authenticator (Face ID / Touch ID
//  / fingerprint / Windows Hello) for an assertion, uses it to decrypt the
//  token, and hands that to Supabase to mint a fresh session.
//
//  How well the token is protected depends on the authenticator:
//   * With the WebAuthn PRF extension (modern iOS/Android/Chrome/Safari), the
//     AES key is derived from a secret only the authenticator can produce after
//     a successful biometric check. The blob on disk is useless without a face
//     or finger.
//   * Without PRF, we fall back to a random key kept in localStorage. Then the
//     biometric is a gate, not a cipher — but that is still no worse than
//     Supabase's own default (a plaintext refresh token in localStorage), and
//     the token expires out of this store after MAX_AGE_DAYS regardless.
//
//  Refresh tokens ROTATE. A stale one is not just useless, it can trip
//  GoTrue's reuse detection and kill the whole session family. So the wrapped
//  copy is re-sealed on every token refresh — and if we can't (because the user
//  signed in with a password this launch and we never derived the key), the
//  blob is marked stale and refuses to be used until it's re-armed.
// ---------------------------------------------------------------------------
(function () {
  const CRED_KEY = "qt.bio.cred";   // { id, prf, email, userId, createdAt }
  const BLOB_KEY = "qt.bio.blob";   // { v, iv, ct, salt, exp, stale }
  const FALLBACK_KEY = "qt.bio.k";  // only used when PRF is unavailable
  const PRF_SALT = new TextEncoder().encode("queen-tracker/quick-unlock/v1");
  const MAX_AGE_DAYS = 30;

  // The AES key for this app session. Populated by enable() / unlock(), which
  // are the only moments we legitimately hold it. Never persisted.
  let liveKey = null;

  // ---- tiny helpers -------------------------------------------------------
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

  function b64u(bytes) {
    let s = "";
    const b = new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(str) {
    const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function read(k) {
    try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }
  function wipe(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  // ---- crypto -------------------------------------------------------------
  async function deriveKey(secretBytes, saltB64) {
    const base = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: unb64u(saltB64), info: enc.encode("qt-quick-unlock") },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function seal(key, plaintext, salt) {
    const iv = rnd(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
    return {
      v: 1,
      iv: b64u(iv),
      ct: b64u(ct),
      salt,
      exp: Date.now() + MAX_AGE_DAYS * 86400000,
    };
  }

  async function open(key, blob) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(blob.iv) }, key, unb64u(blob.ct));
    return dec.decode(pt);
  }

  // ---- WebAuthn -----------------------------------------------------------
  const rpId = () => location.hostname;

  async function available() {
    if (!window.isSecureContext) return false;               // WebAuthn needs https
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    if (!crypto.subtle) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  }

  // Ask the authenticator for its PRF secret. Returns null when the extension
  // isn't supported — the caller then uses the localStorage fallback secret.
  function prfFrom(credential) {
    try {
      const r = credential.getClientExtensionResults?.();
      const first = r && r.prf && r.prf.results && r.prf.results.first;
      return first ? new Uint8Array(first) : null;
    } catch (e) {
      return null;
    }
  }

  function fallbackSecret() {
    let s = null;
    try { s = localStorage.getItem(FALLBACK_KEY); } catch (e) { /* ignore */ }
    if (!s) {
      s = b64u(rnd(32));
      try { localStorage.setItem(FALLBACK_KEY, s); } catch (e) { /* ignore */ }
    }
    return unb64u(s);
  }

  // Run an assertion and come back with the AES key. Must be called from a user
  // gesture — Safari refuses navigator.credentials.get() otherwise.
  async function assertKey(cred, salt) {
    const opts = {
      challenge: rnd(32),
      rpId: rpId(),
      timeout: 60000,
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: unb64u(cred.id), transports: ["internal"] }],
    };
    if (cred.prf) opts.extensions = { prf: { eval: { first: PRF_SALT } } };

    const assertion = await navigator.credentials.get({ publicKey: opts });
    if (!assertion) throw new Error("Unlock cancelled");

    const secret = cred.prf ? prfFrom(assertion) : null;
    return deriveKey(secret || fallbackSecret(), salt);
  }

  // ---- public API ---------------------------------------------------------
  function credential() { return read(CRED_KEY); }
  function blob() { return read(BLOB_KEY); }

  // Enrolled on this device (regardless of whether the stored token is usable).
  function isEnrolled() { return !!credential(); }

  // Enrolled AND holding a token we're willing to use.
  function isReady() {
    const b = blob();
    if (!credential() || !b || b.stale) return false;
    if (b.exp && Date.now() > b.exp) return false;
    return true;
  }

  function needsRearm() { return isEnrolled() && !isReady(); }
  function enrolledEmail() { return (credential() || {}).email || ""; }

  // What to call the thing on this device, so the button doesn't lie.
  function label() {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod|Mac OS X/.test(ua)) return "Face ID / Touch ID";
    if (/Android/.test(ua)) return "fingerprint";
    if (/Windows/.test(ua)) return "Windows Hello";
    return "biometric unlock";
  }

  // Create a passkey on this device and seal the current refresh token with it.
  async function enable(session) {
    if (!session || !session.refresh_token) throw new Error("No active session to remember");
    if (!(await available())) throw new Error("This device has no built-in biometric unlock");

    const userId = session.user && session.user.id ? session.user.id : "queen-tracker";
    const email = (session.user && session.user.email) || "";

    const created = await navigator.credentials.create({
      publicKey: {
        challenge: rnd(32),
        rp: { name: "Queen Tracker", id: rpId() },
        user: { id: enc.encode(userId), name: email || "beekeeper", displayName: email || "Queen Tracker" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        attestation: "none",
        timeout: 60000,
        // Some authenticators can evaluate PRF right here; the rest report only
        // whether they support it, and we evaluate on the first assertion.
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    if (!created) throw new Error("Setup cancelled");

    let prfSupported = false;
    try {
      const ext = created.getClientExtensionResults?.() || {};
      prfSupported = !!(ext.prf && (ext.prf.enabled || (ext.prf.results && ext.prf.results.first)));
    } catch (e) { prfSupported = false; }

    const cred = {
      id: b64u(created.rawId),
      prf: prfSupported,
      email,
      userId,
      createdAt: Date.now(),
    };
    write(CRED_KEY, cred);

    const salt = b64u(rnd(16));
    let key = null;
    const inline = prfFrom(created);
    if (inline) {
      key = await deriveKey(inline, salt);
    } else {
      // Second prompt: we need an assertion to actually get the PRF output.
      // (Or, on a non-PRF authenticator, simply to prove the user is present.)
      key = await assertKey(cred, salt);
    }

    liveKey = key;
    write(BLOB_KEY, await seal(key, session.refresh_token, salt));
    return { prf: prfSupported, label: label() };
  }

  // Prove presence, decrypt, and hand the refresh token back to the caller.
  async function unlock() {
    const cred = credential();
    const b = blob();
    if (!cred || !b) throw new Error("Quick unlock isn't set up on this device");
    if (b.stale) throw new Error("Quick unlock needs re-arming — sign in once with your password");
    if (b.exp && Date.now() > b.exp) {
      disable();
      throw new Error("Quick unlock expired after " + MAX_AGE_DAYS + " days — sign in with your password");
    }
    const key = await assertKey(cred, b.salt);
    let token;
    try {
      token = await open(key, b);
    } catch (e) {
      // Wrong key (e.g. the fallback secret was cleared) — don't leave a blob
      // around that can never be opened.
      markStale();
      throw new Error("Couldn't unlock on this device — sign in with your password");
    }
    liveKey = key;
    return token;
  }

  // Re-arm after a password sign-in: same passkey, freshly sealed token.
  // Needs a user gesture, so the app surfaces this as a button.
  async function rearm(session) {
    const cred = credential();
    if (!cred) return enable(session);
    if (!session || !session.refresh_token) throw new Error("No active session to remember");
    const salt = b64u(rnd(16));
    const key = await assertKey(cred, salt);
    liveKey = key;
    write(BLOB_KEY, await seal(key, session.refresh_token, salt));
    return { prf: !!cred.prf, label: label() };
  }

  // Called on every TOKEN_REFRESHED so the sealed copy never goes stale.
  // Silent when we're holding the key; otherwise it flags the blob unusable
  // rather than letting a rotated-out token get replayed later.
  async function resealQuiet(session) {
    if (!isEnrolled() || !session || !session.refresh_token) return false;
    const b = blob();
    if (!b) return false;
    if (!liveKey) { markStale(); return false; }
    const next = await seal(liveKey, session.refresh_token, b.salt);
    next.stale = false;
    write(BLOB_KEY, next);
    return true;
  }

  function markStale() {
    const b = blob();
    if (b && !b.stale) { b.stale = true; write(BLOB_KEY, b); }
  }

  function disable() {
    liveKey = null;
    wipe(CRED_KEY);
    wipe(BLOB_KEY);
    wipe(FALLBACK_KEY);
  }

  window.QT_BIO = {
    available, label,
    isEnrolled, isReady, needsRearm, enrolledEmail,
    enable, unlock, rearm, resealQuiet, disable,
    invalidate: markStale,
    MAX_AGE_DAYS,
  };
})();
