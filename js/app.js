// ---------------------------------------------------------------------------
//  Queen Tracker — main application logic
// ---------------------------------------------------------------------------
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const boot = $("#boot");

  // Guard: not configured -> show setup screen
  if (!window.QT || !window.QT.configured) {
    boot.classList.add("hidden");
    $("#setup-screen").classList.remove("hidden");
    return;
  }

  const { auth, data } = window.QT;

  // The apiary module needs a live Supabase client. When it isn't there (the
  // mocked test harness, or a stale cached copy of the app) fall back to a stub
  // that behaves like one apiary you own — i.e. exactly how the app worked
  // before sharing existed.
  const sharingLive = !!window.QT.apiaries;
  const APIARIES = window.QT.apiaries || {
    all: () => [], current: () => null, currentId: () => null, label: () => "",
    isOwner: () => true, canWrite: () => true, readOnly: () => false,
    onChange: () => () => {}, refresh: async () => [], reset() {}, switchTo: () => false,
    myInvites: async () => [],
  };

  // The activity vocabulary (js/activities.js). Falls back to an empty-ish stub
  // so a stale cached copy of that file can't take the whole detail view down.
  const ACT = window.QT_ACTIVITIES || {
    TYPES: [{ key: "note", label: "Note / other", icon: "📝", table: null }],
    byKey: { note: { key: "note", label: "Note / other", icon: "📝", table: null } },
    resolve: () => null, MITE_CAP: 20, MITE_SAMPLE_DEFAULT: 300, CUPS: {},
    miteRate: () => null, miteBand: () => null, miteOptions: () => [],
  };

  // Local cache of queens for fast rendering / lineage / dropdowns
  let QUEENS = [];
  let MITE = {};   // queen_id -> most recent mite wash
  let TREAT = {};  // queen_id -> most recent treatment
  let RATING_FIELDS = ["laying_pattern", "brood_quality", "temperament", "honey_production", "hygienic_behavior", "mite_resistance"];
  let pendingPhotos = []; // File[] staged in the form

  // ---------- utilities ----------
  const toast = (msg, ms = 2200) => {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add("hidden"), ms);
  };
  const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const byId = (id) => QUEENS.find((q) => q.id === id);
  const label = (q) => (q ? esc(q.queen_code) + (q.name ? " · " + esc(q.name) : "") : "");

  // "2026-07-14" -> "7/14/26". Parsed as plain Y-M-D so it never shifts a day
  // across time zones the way new Date("2026-07-14") does.
  function fmtDate(d) {
    if (!d) return "";
    const m = String(d).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(d);
    return `${+m[2]}/${+m[3]}/${m[1].slice(2)}`;
  }
  // Days since a Y-M-D date (null if unparseable).
  function daysSince(d) {
    const m = String(d || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
  }

  const STATUS_COLORS = {
    alive: "bg-green-100 text-green-700", dead: "bg-gray-200 text-gray-600",
    superseded: "bg-amber-100 text-amber-700", requeened: "bg-blue-100 text-blue-700",
    sold: "bg-purple-100 text-purple-700", lost: "bg-red-100 text-red-600", banked: "bg-teal-100 text-teal-700",
  };

  function ratingDots(v) {
    v = v || 0;
    let h = '<span class="inline-flex gap-0.5 align-middle">';
    for (let i = 1; i <= 5; i++)
      h += `<span class="rating-dot" style="background:${i <= v ? "#e89a1c" : "#f0dcae"}"></span>`;
    return h + "</span>";
  }

  // ================= AUTH FLOW =================
  let signupMode = false;

  // Reusable show/hide password toggle for a (button, input) pair
  function wirePwToggle(btnSel, inputSel) {
    const btn = $(btnSel), input = $(inputSel);
    if (!btn || !input) return;
    btn.addEventListener("click", () => {
      const revealing = input.type === "password";
      input.type = revealing ? "text" : "password";
      btn.textContent = revealing ? "🙈" : "👁️";
      const lbl = revealing ? "Hide password" : "Show password";
      btn.setAttribute("aria-label", lbl);
      btn.setAttribute("aria-pressed", String(revealing));
      input.focus();
    });
  }
  wirePwToggle("#auth-toggle-pw", "#auth-password");
  wirePwToggle("#auth-toggle-pw2", "#auth-password2");

  // Switch between "sign in" and "create account" — shows the confirm field on signup
  function setAuthMode(signup) {
    signupMode = signup;
    $("#auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("#auth-toggle").textContent = signup ? "Have an account? Sign in" : "New here? Create an account";
    $("#auth-confirm-wrap").classList.toggle("hidden", !signup);
    const pw = $("#auth-password"), pw2 = $("#auth-password2");
    pw2.required = signup;
    pw.setAttribute("autocomplete", signup ? "new-password" : "current-password");
    if (!signup) pw2.value = "";
  }

  $("#auth-toggle").addEventListener("click", () => {
    setAuthMode(!signupMode);
    $("#auth-msg").textContent = "";
  });

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const msg = $("#auth-msg");
    const submitBtn = $("#auth-submit");

    // On account creation, require the two passwords to match before hitting the server
    if (signupMode && password !== $("#auth-password2").value) {
      msg.className = "text-sm mt-3 text-center text-red-600";
      msg.textContent = "Passwords don't match.";
      $("#auth-password2").focus();
      return;
    }

    msg.className = "text-sm mt-3 text-center text-hive-800/70";
    msg.textContent = "…";
    submitBtn.disabled = true;
    try {
      if (signupMode) {
        const { error } = await auth.signUp(email, password);
        if (error) throw error;
        msg.className = "text-sm mt-3 text-center text-green-700";
        msg.textContent = "Account created! If email confirmation is on, check your inbox, then sign in.";
        setAuthMode(false); // back to sign-in mode, hide + clear the confirm field
      } else {
        const { error } = await auth.signIn(email, password);
        if (error) throw error;
        // onChange handler will boot the app
      }
    } catch (err) {
      msg.className = "text-sm mt-3 text-center text-red-600";
      msg.textContent = err.message || "Something went wrong.";
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ================= QUICK UNLOCK (Face ID / Touch ID / fingerprint) =======
  // On a phone the session dies with the app (see supabaseClient.js). This is
  // the pleasant way back in: the refresh token is sealed behind the device's
  // own biometric check, so getting back to your hives is one tap.
  const BIO = window.QT_BIO || null;
  let bioAvailable = false;
  let bioDismissed = false;  // "Not now" — for this run of the app only

  function bioError(err) {
    const name = (err && err.name) || "";
    if (name === "NotAllowedError") return "Unlock cancelled or timed out.";
    if (name === "InvalidStateError") return "That passkey is already registered on this device.";
    if (name === "SecurityError") return "Quick unlock needs the app to be served over https.";
    return (err && err.message) || "Quick unlock failed.";
  }

  function paintBioLogin() {
    const wrap = $("#auth-bio-wrap");
    if (!wrap) return;
    const ready = bioAvailable && BIO.isReady();
    wrap.classList.toggle("hidden", !ready);
    if (!ready) return;
    $("#auth-bio-label").textContent = "Unlock with " + BIO.label();
    const who = BIO.enrolledEmail();
    $("#auth-bio-hint").textContent = who ? who : "";
  }

  function paintBioMenu() {
    const btn = $("#menu-bio");
    if (!btn) return;
    btn.classList.toggle("hidden", !bioAvailable);
    btn.textContent = BIO && BIO.isEnrolled()
      ? "🔐 Quick unlock is on — turn off"
      : "🔐 Turn on quick unlock";
  }

  function paintBioBar() {
    const bar = $("#bio-bar");
    if (!bar) return;
    const hide = () => bar.classList.add("hidden");
    if (!bioAvailable || bioDismissed) return hide();

    const rearm = BIO.needsRearm();
    const fresh = !BIO.isEnrolled();
    // Nagging a desktop that stays signed in anyway is just noise.
    if (fresh && !window.QT.ephemeralSession) return hide();
    if (!rearm && !fresh) return hide();

    $("#bio-bar-text").textContent = rearm
      ? `Quick unlock needs re-arming after a password sign-in — one tap and ${BIO.label()} works again.`
      : `This app signs you out when you close it. Turn on ${BIO.label()} to get back in with a tap.`;
    $("#bio-bar-go").textContent = rearm ? "Re-arm" : "Turn on";
    bar.classList.remove("hidden");
  }

  function paintBio() { paintBioLogin(); paintBioMenu(); paintBioBar(); }

  // Enrol (or re-seal) using the live session. Must run from a click — Safari
  // won't hand out a WebAuthn assertion without a user gesture.
  async function armBio() {
    const session = await auth.getSession();
    if (!session) return toast("Sign in first, then turn on quick unlock");
    try {
      const res = BIO.needsRearm() ? await BIO.rearm(session) : await BIO.enable(session);
      toast(res.prf ? `${res.label} unlock is on` : `${res.label} unlock is on (device-protected)`);
    } catch (err) {
      toast(bioError(err), 3200);
    }
    paintBio();
  }

  async function doBioUnlock() {
    const btn = $("#auth-bio"), msg = $("#auth-msg");
    btn.disabled = true;
    msg.className = "text-sm mt-3 text-center text-hive-800/70";
    msg.textContent = "Waiting for " + BIO.label() + "…";
    try {
      const token = await BIO.unlock();
      const { data: res, error } = await auth.resume(token);
      if (error) {
        // The sealed token was rotated out or revoked — don't offer it again.
        BIO.invalidate();
        throw new Error("That saved sign-in expired. Use your password once, then re-arm quick unlock.");
      }
      msg.textContent = "";
      if (res && res.session) await BIO.resealQuiet(res.session);
    } catch (err) {
      msg.className = "text-sm mt-3 text-center text-red-600";
      msg.textContent = bioError(err);
      paintBioLogin();
    } finally {
      btn.disabled = false;
    }
  }

  (function wireBio() {
    if (!BIO) return;
    const unlockBtn = $("#auth-bio");
    if (unlockBtn) unlockBtn.addEventListener("click", doBioUnlock);
    const go = $("#bio-bar-go");
    if (go) go.addEventListener("click", armBio);
    const no = $("#bio-bar-dismiss");
    if (no) no.addEventListener("click", () => { bioDismissed = true; paintBioBar(); });
    const menuBtn = $("#menu-bio");
    if (menuBtn) menuBtn.addEventListener("click", async () => {
      if (BIO.isEnrolled()) {
        BIO.disable();
        toast("Quick unlock turned off");
        paintBio();
      } else {
        await armBio();
      }
    });
    BIO.available().then((ok) => { bioAvailable = ok; paintBio(); });
  })();

  let appStarted = false;

  auth.onChange(async (session, event) => {
    if (session && session.user) {
      $("#auth-screen").classList.add("hidden");
      $("#menu-email").textContent = session.user.email;

      // Refresh tokens rotate roughly hourly. Re-seal the stored copy so it
      // never goes stale — and don't tear down and rebuild the whole UI for it.
      if (event === "TOKEN_REFRESHED" && appStarted) {
        if (BIO) { await BIO.resealQuiet(session); paintBioBar(); }
        boot.classList.add("hidden");
        return;
      }

      appStarted = true;
      await startApp(session.user.id);
      if (BIO) { await BIO.resealQuiet(session); paintBio(); }
    } else {
      appStarted = false;
      APIARIES.reset();
      apiaryReady = false;
      $("#app").classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
      paintBioLogin();
    }
    boot.classList.add("hidden");
  });

  // Fallback: if no auth event within a moment, decide screen
  (async () => {
    const user = await auth.getUser();
    if (!user) {
      boot.classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
      paintBioLogin();
    }
  })();

  // ================= APP START =================
  // Which apiary is live has to be settled *before* the first query goes out,
  // because every query in supabaseClient.js is filtered to it.
  async function startApp(uid) {
    $("#app").classList.remove("hidden");
    try { await APIARIES.refresh(uid); } catch (e) { toast("Couldn't load apiaries: " + e.message); }
    paintApiary();
    await refresh();
    switchTab("queens");
    handleDeepLink();
    apiaryReady = true;      // from here on, switching apiaries reloads the data
    checkInvites();
  }

  async function refresh() {
    try {
      QUEENS = await data.listQueens();
    } catch (e) {
      toast("Load error: " + e.message);
      QUEENS = [];
    }
    await refreshCardSummaries();
    buildYearFilter();
    renderQueens();
    if (currentTab === "hives") renderHives();
    if (currentTab === "lineage") renderLineage();
    if (currentTab === "stats") renderStats();
  }

  // Re-read the two summary tables behind the queen card. Called after a full
  // refresh and after any timeline write, so logging a mite check updates the
  // card immediately instead of waiting for a reload.
  //
  // Non-fatal by design: if these tables aren't migrated the cards just omit
  // those lines. Worth knowing that this swallow is also what made the original
  // bug so quiet — so it now says something out loud when it trips.
  async function refreshCardSummaries() {
    try { MITE = await data.latestMiteChecks(); }
    catch (e) { MITE = {}; console.warn("Mite summaries unavailable:", e.message || e); }
    try { TREAT = await data.latestTreatments(); }
    catch (e) { TREAT = {}; console.warn("Treatment summaries unavailable:", e.message || e); }
  }

  // ================= TABS =================
  let currentTab = "queens";
  function switchTab(name) {
    currentTab = name;
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $("#tab-queens").classList.toggle("hidden", name !== "queens");
    $("#tab-hives").classList.toggle("hidden", name !== "hives");
    $("#tab-lineage").classList.toggle("hidden", name !== "lineage");
    $("#tab-stats").classList.toggle("hidden", name !== "stats");
    if (name === "hives") renderHives();
    if (name === "lineage") renderLineage();
    if (name === "stats") renderStats();
  }
  $$(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  // ================= HEADER MENU =================
  $("#btn-menu").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").classList.toggle("hidden"); });
  document.addEventListener("click", () => $("#menu").classList.add("hidden"));
  $("#menu").addEventListener("click", (e) => e.stopPropagation());
  $("#menu-signout").addEventListener("click", () => {
    // Signing out revokes the refresh token server-side, so the sealed copy is
    // dead too. Keep the passkey enrolment (re-arming is one tap) but never
    // hand that token to Supabase again.
    if (BIO && BIO.isEnrolled()) BIO.invalidate();
    auth.signOut();
  });
  $("#menu-export").addEventListener("click", openExport);
  $("#menu-share").addEventListener("click", () => openShare());

  // ================= APIARIES: SWITCHER, PERMISSIONS, SHARING =================
  // The database is the authority here — every policy checks membership and
  // role server-side. Everything below is only about not showing someone a
  // button that would come back "permission denied".
  let apiaryReady = false;

  APIARIES.onChange(() => {
    if (!apiaryReady) return;      // startApp() paints and loads once by itself
    paintApiary();
    refresh();
  });

  function paintApiary() {
    const list = APIARIES.all();
    const cur = APIARIES.current();
    // One apiary is the normal case; the switcher would just be noise.
    $("#apiary-bar").classList.toggle("hidden", list.length < 2);
    $("#apiary-label").textContent = APIARIES.label(cur);

    const badge = $("#apiary-role");
    const role = (cur || {}).role;
    badge.textContent = role === "view" ? "Read-only" : role === "edit" ? "Can edit" : "";
    badge.classList.toggle("hidden", role !== "view" && role !== "edit");

    applyPermissions();
  }

  // Hide what this role can't do. Owners do everything; "edit" can add and
  // change but not delete a queen; "view" can only look.
  function applyPermissions() {
    const write = APIARIES.canWrite();
    $("#btn-add").classList.toggle("hidden", !write);
    $("#menu-import").classList.toggle("hidden", !write);
    $("#detail-edit").classList.toggle("hidden", !write);
    if (!write) $("#detail-voice").classList.add("hidden");
  }

  // ---- the switcher dropdown -------------------------------------------
  const apiaryMenu = $("#apiary-menu");
  $("#btn-apiary").addEventListener("click", (e) => {
    e.stopPropagation();
    if (apiaryMenu.classList.contains("hidden")) renderApiaryMenu();
    apiaryMenu.classList.toggle("hidden");
  });
  apiaryMenu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => apiaryMenu.classList.add("hidden"));

  function renderApiaryMenu() {
    const cur = APIARIES.currentId();
    apiaryMenu.innerHTML =
      APIARIES.all().map((a) => `
        <button data-apiary="${esc(a.id)}" class="w-full text-left px-4 py-2 hover:bg-honey-50 flex items-center gap-2">
          <span class="w-4 shrink-0 text-honey-600">${a.id === cur ? "✓" : ""}</span>
          <span class="flex-1 truncate">${esc(APIARIES.label(a))}</span>
          ${a.role === "view" ? '<span class="text-[10px] text-hive-800/40">view</span>' : ""}
        </button>`).join("") +
      `<div class="border-t border-honey-100 mt-1 pt-1">
         <button id="apiary-manage" class="w-full text-left px-4 py-2 hover:bg-honey-50">👥 Sharing &amp; apiaries…</button>
       </div>`;
    $$("[data-apiary]", apiaryMenu).forEach((b) =>
      b.addEventListener("click", () => { apiaryMenu.classList.add("hidden"); APIARIES.switchTo(b.dataset.apiary); }));
    $("#apiary-manage", apiaryMenu).addEventListener("click", () => { apiaryMenu.classList.add("hidden"); openShare(); });
  }

  // ---- invites waiting for you -----------------------------------------
  // No mail is sent; an invite simply shows up the next time you sign in.
  async function checkInvites() {
    if (!sharingLive) return;
    const bar = $("#invite-bar");
    let invites = [];
    try { invites = (await APIARIES.myInvites()) || []; } catch (e) { return; }
    if (!invites.length) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
    bar.classList.remove("hidden");
    bar.innerHTML = invites.map((i) => `
      <div class="rounded-xl border border-honey-200 bg-honey-50 px-4 py-3 flex flex-wrap items-center gap-3">
        <span class="text-xl">👥</span>
        <p class="text-sm text-hive-800/80 flex-1 min-w-[12rem]">
          <b>${esc(i.invited_by_email || "Someone")}</b> shared <b>${esc(i.apiary_name || "an apiary")}</b> with you
          (${i.role === "edit" ? "you can add and edit" : "read-only"}).
        </p>
        <button data-accept="${esc(i.id)}" class="bg-honey-500 hover:bg-honey-600 text-white font-semibold rounded-lg px-4 py-1.5 text-sm">Accept</button>
        <button data-decline="${esc(i.id)}" class="text-sm text-hive-800/50 hover:text-hive-800 px-2">Decline</button>
      </div>`).join("");
    $$("[data-accept]", bar).forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await APIARIES.acceptInvite(b.dataset.accept); toast("Joined"); } catch (e) { toast(e.message); b.disabled = false; return; }
      checkInvites();
    }));
    $$("[data-decline]", bar).forEach((b) => b.addEventListener("click", async () => {
      try { await APIARIES.declineInvite(b.dataset.decline); } catch (e) { toast(e.message); }
      checkInvites();
    }));
  }

  // ---- the Sharing screen ----------------------------------------------
  const shareModal = $("#share-modal");
  $("#share-close").addEventListener("click", closeShare);
  shareModal.addEventListener("click", (e) => { if (e.target === shareModal) closeShare(); });
  function closeShare() { shareModal.classList.add("hidden"); document.body.style.overflow = ""; }

  async function openShare() {
    $("#menu").classList.add("hidden");
    if (!sharingLive) { toast("Sharing needs a reload — the app was updated."); return; }
    shareModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    await renderShare();
  }

  const ROLE_WORD = { owner: "Owner", edit: "Can add & edit", view: "Read-only" };

  async function renderShare() {
    const body = $("#share-body");
    const cur = APIARIES.current();
    if (!cur) { body.innerHTML = `<p class="text-sm text-hive-800/60">No apiary loaded.</p>`; return; }
    const owner = cur.role === "owner";
    body.innerHTML = `<p class="text-sm text-hive-800/50">Loading…</p>`;

    let members = [], pending = [], codes = [];
    try { members = (await APIARIES.members(cur.id)) || []; } catch (e) { /* shown below */ }
    if (owner) {
      try { pending = (await APIARIES.pendingInvites(cur.id)) || []; } catch (e) {}
      try { codes = (await APIARIES.codes(cur.id)) || []; } catch (e) {}
    }
    const codeFor = (r) => (codes.find((c) => c.role === r) || {}).code || "";

    body.innerHTML = `
      <!-- which apiary -->
      <div class="rounded-xl bg-honey-50 border border-honey-100 px-4 py-3 mb-4">
        <div class="flex items-center gap-2">
          <div class="font-semibold text-honey-800 flex-1 truncate">${esc(APIARIES.label(cur))}</div>
          <span class="text-[11px] rounded-full bg-white px-2 py-0.5 text-hive-800/60">${ROLE_WORD[cur.role] || ""}</span>
        </div>
        ${owner && !cur.is_personal ? `
          <div class="flex gap-2 mt-2">
            <input id="sh-name" class="inp flex-1" value="${esc(cur.name)}" />
            <button id="sh-rename" class="border border-honey-200 hover:bg-white rounded-lg px-3 text-sm">Rename</button>
          </div>` : ""}
      </div>

      <!-- who can see it -->
      <h3 class="text-honey-700 font-semibold text-xs uppercase tracking-wide mb-2">People</h3>
      <ul class="space-y-1 text-sm mb-4">
        ${members.map((m) => `
          <li class="flex items-center gap-2 py-1 border-b border-honey-50">
            <span class="flex-1 truncate">${esc(m.email || "someone")}${m.is_me ? ' <span class="text-hive-800/40">(you)</span>' : ""}</span>
            ${owner && m.role !== "owner" ? `
              <select data-role-for="${esc(m.user_id)}" class="border border-honey-200 rounded-lg px-1.5 py-1 text-xs">
                <option value="view" ${m.role === "view" ? "selected" : ""}>Read-only</option>
                <option value="edit" ${m.role === "edit" ? "selected" : ""}>Can add &amp; edit</option>
              </select>
              <button data-remove="${esc(m.user_id)}" class="text-red-500 text-xs hover:underline">remove</button>`
            : `<span class="text-xs text-hive-800/40">${ROLE_WORD[m.role] || ""}</span>`}
          </li>`).join("") || `<li class="text-hive-800/40">Just you.</li>`}
      </ul>

      ${owner ? `
        ${pending.length ? `
          <h3 class="text-honey-700 font-semibold text-xs uppercase tracking-wide mb-2">Invited, not joined yet</h3>
          <ul class="space-y-1 text-sm mb-4">
            ${pending.map((p) => `
              <li class="flex items-center gap-2 py-1 border-b border-honey-50">
                <span class="flex-1 truncate">${esc(p.email)}</span>
                <span class="text-xs text-hive-800/40">${ROLE_WORD[p.role] || ""}</span>
                <button data-revoke="${esc(p.id)}" class="text-red-500 text-xs hover:underline">revoke</button>
              </li>`).join("")}
          </ul>` : ""}

        <h3 class="text-honey-700 font-semibold text-xs uppercase tracking-wide mb-2">Invite someone</h3>
        <div class="flex flex-wrap gap-2 mb-1">
          <input id="sh-email" type="email" class="inp flex-1 min-w-[10rem]" placeholder="their email" />
          <select id="sh-invite-role" class="border border-honey-200 rounded-lg px-2 text-sm">
            <option value="view">Read-only</option><option value="edit">Can add &amp; edit</option>
          </select>
          <button id="sh-invite" class="bg-honey-500 hover:bg-honey-600 text-white font-semibold rounded-lg px-4 py-2 text-sm">Invite</button>
        </div>
        <p class="text-xs text-hive-800/50 mb-4">No email is sent — the invite is waiting for them the next time they sign in. Or hand them the code below.</p>

        <h3 class="text-honey-700 font-semibold text-xs uppercase tracking-wide mb-2">Share code</h3>
        <div class="space-y-2 mb-4">
          ${["view", "edit"].map((r) => `
            <div class="flex items-center gap-2 text-sm">
              <span class="w-24 shrink-0 text-hive-800/50 text-xs">${ROLE_WORD[r]}</span>
              ${codeFor(r)
                ? `<code class="font-mono font-bold text-honey-800 tracking-wider flex-1">${esc(codeFor(r))}</code>
                   <button data-copy="${esc(codeFor(r))}" class="text-xs border border-honey-200 rounded-lg px-2 py-1 hover:bg-honey-50">Copy</button>
                   <button data-rotate="${r}" class="text-xs border border-honey-200 rounded-lg px-2 py-1 hover:bg-honey-50">New code</button>
                   <button data-revoke-code="${esc(codeFor(r))}" class="text-red-500 text-xs hover:underline">off</button>`
                : `<span class="flex-1 text-hive-800/40 text-xs">none</span>
                   <button data-mint="${r}" class="text-xs border border-honey-200 rounded-lg px-2 py-1 hover:bg-honey-50">Create</button>`}
            </div>`).join("")}
        </div>
      ` : `<p class="text-xs text-hive-800/50 mb-4">Only the owner can invite people or change what anyone can do.</p>`}

      <!-- joining / creating -->
      <div class="border-t border-honey-100 pt-4 space-y-3">
        <div>
          <h3 class="text-honey-700 font-semibold text-xs uppercase tracking-wide mb-2">Join an apiary</h3>
          <div class="flex gap-2">
            <input id="sh-code" class="inp flex-1 font-mono uppercase" placeholder="HIVE-7K2Q" />
            <button id="sh-join" class="border border-honey-200 hover:bg-honey-50 rounded-lg px-4 text-sm font-medium">Join</button>
          </div>
        </div>
        <div>
          <h3 class="text-honey-700 font-semibold text-xs uppercase tracking-wide mb-2">Start another apiary</h3>
          <div class="flex gap-2">
            <input id="sh-new" class="inp flex-1" placeholder="e.g. Back field yard" />
            <button id="sh-create" class="border border-honey-200 hover:bg-honey-50 rounded-lg px-4 text-sm font-medium">Create</button>
          </div>
        </div>
        ${cur.role !== "owner"
          ? `<button id="sh-leave" class="text-sm text-red-600 hover:underline">Leave ${esc(APIARIES.label(cur))}</button>`
          : (!cur.is_personal
            ? `<button id="sh-delete" class="text-sm text-red-600 hover:underline">Delete this apiary and everything in it</button>`
            : "")}
      </div>`;

    wireShare(cur);
  }

  // Every action re-reads from the server rather than patching the DOM: the
  // panel is small, and a stale members list is exactly the thing you don't
  // want when you're deciding who can touch your bees.
  function wireShare(cur) {
    const body = $("#share-body");
    const go = async (fn, ok) => {
      try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message); }
      await renderShare();
    };

    const rn = $("#sh-rename", body);
    if (rn) rn.addEventListener("click", () => {
      const n = $("#sh-name", body).value.trim();
      if (n) go(() => APIARIES.rename(cur.id, n), "Renamed");
    });

    $$("[data-role-for]", body).forEach((s) => s.addEventListener("change", () =>
      go(() => APIARIES.setRole(cur.id, s.dataset.roleFor, s.value), "Updated")));
    $$("[data-remove]", body).forEach((b) => b.addEventListener("click", () => {
      if (confirm("Remove this person? They lose access immediately.")) go(() => APIARIES.removeMember(cur.id, b.dataset.remove), "Removed");
    }));
    $$("[data-revoke]", body).forEach((b) => b.addEventListener("click", () =>
      go(() => APIARIES.revokeInvite(b.dataset.revoke), "Invite revoked")));

    const inv = $("#sh-invite", body);
    if (inv) inv.addEventListener("click", () => {
      const em = $("#sh-email", body).value.trim();
      if (!em) return toast("Enter their email");
      go(() => APIARIES.invite(cur.id, em, $("#sh-invite-role", body).value), "Invited — they'll see it when they sign in");
    });

    $$("[data-mint]", body).forEach((b) => b.addEventListener("click", () =>
      go(() => APIARIES.shareCode(cur.id, b.dataset.mint, false), "Code created")));
    $$("[data-rotate]", body).forEach((b) => b.addEventListener("click", () => {
      if (confirm("Make a new code? The old one stops working.")) go(() => APIARIES.shareCode(cur.id, b.dataset.rotate, true), "New code");
    }));
    $$("[data-revoke-code]", body).forEach((b) => b.addEventListener("click", () =>
      go(() => APIARIES.revokeCode(b.dataset.revokeCode), "Code turned off")));
    $$("[data-copy]", body).forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); } catch (e) { toast(b.dataset.copy); }
    }));

    $("#sh-join", body).addEventListener("click", () => {
      const c = $("#sh-code", body).value.trim();
      if (!c) return toast("Paste the code they sent you");
      go(async () => { const row = await APIARIES.redeem(c); toast("Joined " + (row && row.name ? row.name : "")); });
    });
    $("#sh-create", body).addEventListener("click", () => {
      const n = $("#sh-new", body).value.trim();
      if (!n) return toast("Give it a name");
      go(() => APIARIES.create(n), "Created");
    });

    const lv = $("#sh-leave", body);
    if (lv) lv.addEventListener("click", () => {
      if (confirm("Leave this apiary? You'll lose access to its queens.")) go(() => APIARIES.leave(cur.id), "Left");
    });
    const dl = $("#sh-delete", body);
    if (dl) dl.addEventListener("click", () => {
      if (confirm("Delete " + APIARIES.label(cur) + "? Its queens, photos and notes go with it. This cannot be undone.")) {
        go(() => APIARIES.destroy(cur.id), "Deleted");
      }
    });
  }

  // ================= QUEENS LIST =================
  const buildYearFilter = () => {
    const years = [...new Set(QUEENS.map((q) => q.year).filter(Boolean))].sort((a, b) => b - a);
    const sel = $("#filter-year");
    const cur = sel.value;
    sel.innerHTML = '<option value="">All years</option>' + years.map((y) => `<option>${y}</option>`).join("");
    sel.value = cur;
  };

  ["#search", "#filter-year", "#filter-status", "#sort-by"].forEach((s) =>
    $(s).addEventListener("input", renderQueens)
  );

  function filteredSorted() {
    const term = $("#search").value.toLowerCase().trim();
    const fy = $("#filter-year").value;
    const fs = $("#filter-status").value;
    let list = QUEENS.filter((q) => {
      if (fy && String(q.year) !== fy) return false;
      if (fs && q.status !== fs) return false;
      if (term) {
        const hay = [q.queen_code, q.name, q.current_hive, q.race_line, q.notable_traits, q.notes].join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    const sort = $("#sort-by").value;
    list.sort((a, b) => {
      if (sort === "code") return (a.queen_code || "").localeCompare(b.queen_code || "");
      if (sort === "year_desc") return (b.year || 0) - (a.year || 0);
      if (sort === "laying_desc") return (b.laying_pattern || 0) - (a.laying_pattern || 0);
      return new Date(b.created_at) - new Date(a.created_at);
    });
    return list;
  }

  // ---- Queen-card summary lines ----------------------------------------
  // Mite wash is shown always (so an empty one reads as "go check this hive");
  // treatment lines only appear when there's actually a treatment on record.

  // Thresholds are counts, not rates: 0-1 is clean, 2-8 is watch it, 9+ is act.
  // Nine mites in a half-cup (300-bee) sample is 3%, the standard action point,
  // which is why the two agree at the top end. The infestation percentage is
  // shown alongside so a non-standard sample size still reads correctly.
  function miteRate(rec) {
    return ACT.miteRate(rec.mite_count, rec.mite_sample_size);
  }
  function miteTone(rec) {
    const band = ACT.miteBand(rec.mite_count, rec.mite_count_capped, rec.mite_sample_size);
    if (band === "red") return "text-red-600 font-semibold";
    if (band === "amber") return "text-amber-600 font-semibold";
    if (band === "green") return "text-green-700";
    return "text-hive-800/70";
  }
  function miteLines(queenId) {
    const rec = MITE[queenId];
    if (!rec) {
      return `<div class="text-hive-800/40">Last Mite Check: <span class="italic">none recorded</span></div>`;
    }
    const age = daysSince(rec.date);
    const stale = age != null && age > 30 ? ` <span class="text-hive-800/40">(${age}d ago)</span>` : "";
    const capped = !!rec.mite_count_capped;
    const rate = miteRate(rec);
    const per = rate == null ? "" : ` <span class="text-hive-800/50">(${capped ? "≥" : ""}${rate.toFixed(1)}%)</span>`;
    const shown = capped ? "20+" : rec.mite_count;
    const treat = ACT.miteBand(rec.mite_count, capped, rec.mite_sample_size) === "red" ? " — TREAT" : "";
    return `<div>Last Mite Check: ${esc(fmtDate(rec.date))}${stale}</div>
            <div class="${miteTone(rec)}">Mite Count: ${shown}${per}${treat}</div>`;
  }
  function treatmentLines(queenId) {
    const rec = TREAT[queenId];
    if (!rec) return "";                       // nonmandatory — hide when absent
    const date = rec.treatment_date ? `<div>Last Treatment Date: ${esc(fmtDate(rec.treatment_date))}</div>` : "";
    // Show the cascade the way it was picked — "Chemical · Oxalic Acid" — but
    // fall back to the bare product for rows written before categories existed.
    const label = [rec.category, rec.product].filter(Boolean).join(" · ");
    const type = label ? `<div>Treatment Type: ${esc(label)}</div>` : "";
    return date + type;
  }

  async function renderQueens() {
    const grid = $("#queens-grid");
    const list = filteredSorted();
    $("#queens-empty").classList.toggle("hidden", QUEENS.length !== 0);
    grid.innerHTML = list
      .map((q) => {
        const mom = q.mother_queen_id ? byId(q.mother_queen_id) : null;
        const sc = STATUS_COLORS[q.status] || "bg-gray-100 text-gray-600";
        return `
        <div class="queen-card bg-white rounded-xl card-shadow overflow-hidden cursor-pointer hover:ring-2 hover:ring-honey-300" data-id="${q.id}">
          <div class="h-72 sm:h-40 lg:h-36 bg-honey-100 flex items-center justify-center text-4xl thumb" data-thumb="${q.id}">🐝</div>
          <div class="p-3">
            <div class="flex items-center gap-2">
              <h3 class="font-bold text-honey-800 truncate">${esc(q.queen_code)}</h3>
              <span class="text-xs px-2 py-0.5 rounded-full ${sc} ml-auto capitalize">${esc(q.status || "")}</span>
            </div>
            ${q.name ? `<p class="text-sm text-hive-800/70 -mt-0.5">${esc(q.name)}</p>` : ""}
            <div class="mt-2 text-xs text-hive-800/70 space-y-1">
              <div>${q.year ? "📅 " + q.year : ""} ${q.race_line ? " · 🧬 " + esc(q.race_line) : ""}</div>
              <div>${q.current_hive ? "Hive: " + esc(q.current_hive) : ""}</div>
              ${mom ? `<div>👑 mother: ${label(mom)}</div>` : ""}
              ${miteLines(q.id)}
              ${treatmentLines(q.id)}
              <div class="flex items-center gap-1 pt-1">laying ${ratingDots(q.laying_pattern)}</div>
            </div>
          </div>
        </div>`;
      })
      .join("");
    $$(".queen-card", grid).forEach((c) => c.addEventListener("click", () => openDetail(c.dataset.id)));
    // async load thumbnails
    for (const q of list) loadThumb(q.id);
  }

  async function loadThumb(queenId) {
    try {
      const photos = await data.listPhotos(queenId);
      if (!photos.length) return;
      const primary = photos.find((p) => p.is_primary) || photos[0];
      const url = await data.photoUrl(primary.storage_path);
      const el = document.querySelector(`.thumb[data-thumb="${queenId}"]`);
      if (el && url) {
        // Two layers of the same photo: a blurred, zoomed copy fills the tile
        // edge to edge, and the real one sits on top at "contain". Nothing is
        // ever cropped — a portrait shot of a whole hive shows the whole hive —
        // and there's no dead honey-coloured band beside it either.
        const src = String(url).replace(/'/g, "%27");
        el.textContent = "";
        el.innerHTML =
          `<div class="thumb-blur" style="background-image:url('${src}')"></div>` +
          `<div class="thumb-img" style="background-image:url('${src}')"></div>`;
      }
    } catch (e) { /* ignore */ }
  }

  // ================= FORM (add / edit) =================
  const formModal = $("#form-modal");
  const F = (k) => $("#f-" + k);
  const CORE_FIELDS = [
    "queen_code","name","source_method","graft_date","emergence_date","year","season","drone_source",
    "current_hive","mated_status","mating_date","productivity_notes",
    "race_line","marking_color","notable_traits",
    "status","status_date","notes",
  ];

  function buildRatingWidgets() {
    $$(".rating").forEach((box) => {
      if (box.dataset.built) return;
      const field = box.dataset.field;
      const wrap = document.createElement("div");
      wrap.className = "flex gap-1 mt-1";
      for (let i = 1; i <= 5; i++) {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "w-7 h-7 rounded-full border border-honey-300 text-xs font-semibold";
        dot.textContent = i;
        dot.addEventListener("click", () => setRating(field, i));
        wrap.appendChild(dot);
      }
      const clear = document.createElement("button");
      clear.type = "button"; clear.className = "text-xs text-hive-800/40 ml-1"; clear.textContent = "clear";
      clear.addEventListener("click", () => setRating(field, null));
      wrap.appendChild(clear);
      box.appendChild(wrap);
      box.dataset.built = "1";
    });
  }
  const ratingState = {};
  function setRating(field, val) {
    ratingState[field] = val;
    const box = document.querySelector(`.rating[data-field="${field}"]`);
    $$("button", box).forEach((b, idx) => {
      if (b.textContent === "clear") return;
      const n = idx + 1;
      b.style.background = val && n <= val ? "#e89a1c" : "white";
      b.style.color = val && n <= val ? "white" : "#894b16";
    });
  }

  function populateMotherDropdowns(excludeId) {
    const opts = '<option value="">— none —</option>' +
      QUEENS.filter((q) => q.id !== excludeId)
        .sort((a, b) => (b.year || 0) - (a.year || 0) || (a.queen_code || "").localeCompare(b.queen_code || ""))
        .map((q) => `<option value="${q.id}">${label(q)}${q.year ? " (" + q.year + ")" : ""}</option>`).join("");
    F("mother_queen_id").innerHTML = opts;
    F("replaced_by_id").innerHTML = opts;
  }

  function openForm(queen) {
    if (!APIARIES.canWrite()) { toast("You have read-only access to this apiary."); return; }
    buildRatingWidgets();
    pendingPhotos = [];
    $("#photo-preview").innerHTML = "";
    $("#f-photos").value = "";
    $("#f-photo-camera").value = "";
    $("#queen-form").reset();
    Object.keys(ratingState).forEach((k) => (ratingState[k] = null));
    RATING_FIELDS.forEach((f) => setRating(f, null));

    populateMotherDropdowns(queen ? queen.id : null);

    if (queen) {
      $("#form-title").textContent = "Edit Queen — " + queen.queen_code;
      $("#f-id").value = queen.id;
      CORE_FIELDS.forEach((f) => { if (F(f)) F(f).value = queen[f] == null ? "" : queen[f]; });
      F("mother_queen_id").value = queen.mother_queen_id || "";
      F("replaced_by_id").value = queen.replaced_by_id || "";
      RATING_FIELDS.forEach((f) => setRating(f, queen[f]));
      // Deleting a queen is the owner's call alone — an editor can only change her.
      $("#form-delete").classList.toggle("hidden", !APIARIES.isOwner());
      renderExistingPhotos(queen.id);
    } else {
      $("#form-title").textContent = "New Queen";
      $("#f-id").value = "";
      F("status").value = "alive";
      F("year").value = new Date().getFullYear();
      $("#form-delete").classList.add("hidden");
    }
    formModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  function closeForm() {
    formModal.classList.add("hidden");
    document.body.style.overflow = "";
  }
  $("#btn-add").addEventListener("click", () => openForm(null));
  $("#form-close").addEventListener("click", closeForm);
  $("#form-cancel").addEventListener("click", closeForm);

  // photo staging
  // Two inputs feed the same staging list: the plain file picker (library, files,
  // and whatever else the OS offers) and a camera-only one behind the Take a photo
  // button. They're separate because `capture` on the main input skips the library
  // entirely on a phone, which is the opposite of what you want most of the time.
  function stagePhotos(e) {
    for (const file of e.target.files) {
      pendingPhotos.push(file);
      const url = URL.createObjectURL(file);
      const chip = document.createElement("div");
      chip.className = "relative";
      chip.innerHTML = `<img src="${url}" class="w-16 h-16 object-cover rounded-lg border border-honey-200" />`;
      $("#photo-preview").appendChild(chip);
    }
    e.target.value = "";
  }
  $("#f-photos").addEventListener("change", stagePhotos);
  $("#f-photo-camera").addEventListener("change", stagePhotos);
  $("#photo-camera-btn").addEventListener("click", () => $("#f-photo-camera").click());

  async function renderExistingPhotos(queenId) {
    const box = $("#photo-preview");
    const photos = await data.listPhotos(queenId);
    // The card and the hive tile show whichever photo is flagged primary, falling
    // back to the oldest. Reflect that same rule here so the star always marks the
    // picture actually on display, even before anyone has chosen one.
    const shown = photos.find((p) => p.is_primary) || photos[0];

    // Star buttons live outside the per-photo closure so picking one can un-light
    // the others without re-fetching the whole list.
    const stars = new Map();
    function paint(activeId) {
      stars.forEach((s, id) => {
        const on = id === activeId;
        s.btn.textContent = on ? "★" : "☆";
        s.btn.title = on ? "This is the queen's main photo" : "Use as the main photo";
        s.btn.className = "absolute -bottom-1 -left-1 rounded-full w-5 h-5 text-xs leading-none " +
          (on ? "bg-honey-500 text-white" : "bg-white/90 text-hive-800/60 border border-honey-200");
        s.img.classList.toggle("ring-2", on);
        s.img.classList.toggle("ring-honey-500", on);
      });
    }

    for (const p of photos) {
      const url = await data.photoUrl(p.storage_path);
      const chip = document.createElement("div");
      chip.className = "relative group";
      chip.innerHTML = `
        <img src="${url}" class="w-16 h-16 object-cover rounded-lg border border-honey-200" />
        <button type="button" data-role="star"></button>
        <button type="button" data-role="del" title="Remove" class="absolute -top-2 -right-2 bg-red-600 text-white rounded-full w-5 h-5 text-xs">×</button>`;

      const starBtn = chip.querySelector('[data-role="star"]');
      stars.set(p.id, { btn: starBtn, img: chip.querySelector("img") });
      starBtn.addEventListener("click", async () => {
        const prev = photos.find((x) => x.is_primary) || null;
        try {
          paint(p.id);                       // optimistic: the tap should feel instant
          await data.setPrimaryPhoto(queenId, p.id);
          photos.forEach((x) => (x.is_primary = x.id === p.id));
          toast("Main photo updated");
          renderQueens();                    // the card behind the form updates too
        } catch (err) {
          paint(prev ? prev.id : (photos[0] && photos[0].id));   // put the star back
          toast("Couldn't set the main photo: " + (err.message || err), 4000);
        }
      });

      chip.querySelector('[data-role="del"]').addEventListener("click", async () => {
        if (!confirm("Delete this photo?")) return;
        const wasPrimary = p.is_primary || (shown && shown.id === p.id);
        await data.deletePhoto(p);
        stars.delete(p.id);
        chip.remove();
        const idx = photos.findIndex((x) => x.id === p.id);
        if (idx >= 0) photos.splice(idx, 1);
        // Deleting the main photo would otherwise leave the queen starless; hand
        // the badge to the next one so the card never falls back silently.
        if (wasPrimary && photos.length) {
          try {
            await data.setPrimaryPhoto(queenId, photos[0].id);
            photos.forEach((x) => (x.is_primary = x.id === photos[0].id));
            paint(photos[0].id);
          } catch (err) { /* the fallback-to-oldest read path still covers us */ }
        }
        toast("Photo deleted");
        renderQueens();
      });

      box.appendChild(chip);
    }
    paint(shown ? shown.id : null);
  }

  $("#queen-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = $("#form-save");
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    try {
      const row = { id: $("#f-id").value || undefined };
      CORE_FIELDS.forEach((f) => { if (F(f)) row[f] = F(f).value; });
      row.mother_queen_id = F("mother_queen_id").value || null;
      row.replaced_by_id = F("replaced_by_id").value || null;
      RATING_FIELDS.forEach((f) => (row[f] = ratingState[f] ?? null));
      if (row.year) row.year = parseInt(row.year, 10);

      const saved = await data.saveQueen(row);

      if (pendingPhotos.length) {
        saveBtn.textContent = "Uploading photos…";
        for (const file of pendingPhotos) await data.uploadPhoto(saved.id, file);
      }
      toast("Queen saved 🐝");
      closeForm();
      await refresh();
    } catch (err) {
      toast("Save failed: " + err.message, 4000);
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = "Save queen";
    }
  });

  $("#form-delete").addEventListener("click", async () => {
    const id = $("#f-id").value;
    const q = byId(id);
    if (!q) return;
    if (!confirm(`Delete queen "${q.queen_code}"? This also removes her photos and events. This cannot be undone.`)) return;
    try {
      await data.deleteQueen(id);
      toast("Queen deleted");
      closeForm();
      await refresh();
    } catch (err) { toast("Delete failed: " + err.message, 4000); }
  });

  // ================= DETAIL VIEW =================
  const detailModal = $("#detail-modal");
  let detailId = null;
  $("#detail-close").addEventListener("click", () => { detailModal.classList.add("hidden"); document.body.style.overflow = ""; });
  $("#detail-edit").addEventListener("click", () => {
    detailModal.classList.add("hidden");
    openForm(byId(detailId));
  });

  async function openDetail(id) {
    detailId = id;
    const q = byId(id);
    if (!q) return;
    $("#detail-title").textContent = q.queen_code + (q.name ? " · " + q.name : "");

    // QR button — only when this queen is assigned to a hive
    const dqr = $("#detail-qr");
    const hiveLabel = (q.current_hive || "").trim();
    if (hiveLabel) {
      dqr.classList.remove("hidden");
      dqr.onclick = () => openQrModal(hiveLabel);
    } else {
      dqr.classList.add("hidden");
      dqr.onclick = null;
    }

    // Voice-note button — any queen you're allowed to write to
    const canWrite = APIARIES.canWrite();
    const dvoice = $("#detail-voice");
    dvoice.classList.toggle("hidden", !canWrite);
    dvoice.onclick = canWrite ? () => openVoiceModal(q.id, hiveLabel) : null;
    $("#detail-edit").classList.toggle("hidden", !canWrite);
    const body = $("#detail-body");
    const mom = q.mother_queen_id ? byId(q.mother_queen_id) : null;
    const kids = QUEENS.filter((k) => k.mother_queen_id === q.id);
    const repl = q.replaced_by_id ? byId(q.replaced_by_id) : null;

    const row = (lbl, val) => (val || val === 0 ? `<div class="flex gap-2 py-1 border-b border-honey-50"><dt class="w-40 shrink-0 text-hive-800/50 text-sm">${lbl}</dt><dd class="text-sm">${val}</dd></div>` : "");
    const rate = (lbl, v) => (v ? `<div class="flex gap-2 py-1 border-b border-honey-50 items-center"><dt class="w-40 shrink-0 text-hive-800/50 text-sm">${lbl}</dt><dd>${ratingDots(v)} <span class="text-xs text-hive-800/50">${v}/5</span></dd></div>` : "");

    body.innerHTML = `
      <div id="detail-photos" class="flex flex-wrap gap-2 mb-4"></div>
      <div class="grid sm:grid-cols-2 gap-x-6">
        <dl>
          <div class="text-honey-700 font-semibold text-xs uppercase mt-1 mb-1">Core</div>
          ${row("Status", `<span class="capitalize px-2 py-0.5 rounded-full text-xs ${STATUS_COLORS[q.status]||''}">${esc(q.status||"")}</span> ${q.status_date? " · "+q.status_date:""}`)}
          ${row("Source method", esc(q.source_method))}
          ${row("Year / season", [q.year, q.season].filter(Boolean).join(" · "))}
          ${row("Graft date", q.graft_date)}
          ${row("Emergence date", q.emergence_date)}
          ${row("Mother", mom ? `<a href="#" class="text-honey-700 underline" data-goto="${mom.id}">${label(mom)}</a>` : "—")}
          ${row("Drone source", esc(q.drone_source))}
          ${row("Daughters", kids.length ? kids.map(k=>`<a href="#" class="text-honey-700 underline mr-2" data-goto="${k.id}">${label(k)}</a>`).join("") : "—")}
          ${repl ? row("Replaced by", `<a href="#" class="text-honey-700 underline" data-goto="${repl.id}">${label(repl)}</a>`) : ""}
        </dl>
        <dl>
          <div class="text-honey-700 font-semibold text-xs uppercase mt-1 mb-1">Hive &amp; performance</div>
          ${row("Current hive", esc(q.current_hive))}
          ${row("Mated status", [esc(q.mated_status), q.mating_date].filter(Boolean).join(" · "))}
          ${rate("Laying pattern", q.laying_pattern)}
          ${rate("Brood quality", q.brood_quality)}
          ${rate("Temperament", q.temperament)}
          ${rate("Honey production", q.honey_production)}
          <div class="text-honey-700 font-semibold text-xs uppercase mt-3 mb-1">Genetics</div>
          ${row("Race / line", esc(q.race_line))}
          ${row("Marking", esc(q.marking_color))}
          ${rate("Hygienic behavior", q.hygienic_behavior)}
          ${rate("Mite resistance", q.mite_resistance)}
        </dl>
      </div>
      ${q.notable_traits ? `<div class="mt-3"><div class="text-honey-700 font-semibold text-xs uppercase mb-1">Notable traits</div><p class="text-sm whitespace-pre-wrap">${esc(q.notable_traits)}</p></div>` : ""}
      ${q.productivity_notes ? `<div class="mt-3"><div class="text-honey-700 font-semibold text-xs uppercase mb-1">Productivity notes</div><p class="text-sm whitespace-pre-wrap">${esc(q.productivity_notes)}</p></div>` : ""}
      ${q.notes ? `<div class="mt-3"><div class="text-honey-700 font-semibold text-xs uppercase mb-1">Notes</div><p class="text-sm whitespace-pre-wrap">${esc(q.notes)}</p></div>` : ""}

      <!-- Events timeline -->
      <div class="mt-5 pt-4 border-t border-honey-100">
        <div class="flex items-center gap-2 mb-2">
          <h3 class="text-honey-700 font-semibold text-sm uppercase">Timeline</h3>
          <button id="add-event-btn" class="${canWrite ? "" : "hidden "}ml-auto text-xs bg-honey-100 text-honey-700 rounded px-2 py-1 font-medium">+ Add entry</button>
        </div>
        <form id="event-form" class="hidden mb-3 space-y-2 bg-honey-50 rounded-lg p-3">
          <div class="flex gap-2 flex-wrap sm:flex-nowrap">
            <input id="ev-date" type="date" class="inp" style="max-width:150px" />
            <select id="ev-type" class="inp" style="max-width:220px" aria-label="Activity"></select>
          </div>
          <!-- Filled by renderEventCascade() from js/activities.js. -->
          <div id="ev-cascade" class="flex gap-2 flex-wrap items-end"></div>
          <input id="ev-note" class="inp" placeholder="note (optional)" />
          <div class="flex gap-2 justify-end">
            <button type="button" id="ev-cancel" class="rounded-lg px-3 py-1.5 text-sm border border-honey-200 hover:bg-white">Cancel</button>
            <button class="bg-honey-500 hover:bg-honey-600 text-white rounded-lg px-4 py-1.5 text-sm font-semibold">Add</button>
          </div>
        </form>
        <ul id="events-list" class="space-y-1 text-sm"></ul>
      </div>`;

    // wire cross-links
    $$("[data-goto]", body).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openDetail(a.dataset.goto); }));

    detailModal.classList.remove("hidden");
    document.body.style.overflow = "hidden";

    // photos
    const pbox = $("#detail-photos");
    const photos = await data.listPhotos(id);
    if (!photos.length) pbox.innerHTML = `<div class="w-full h-40 bg-honey-100 rounded-xl flex items-center justify-center text-5xl">🐝</div>`;
    for (const p of photos) {
      const url = await data.photoUrl(p.storage_path);
      const im = document.createElement("img");
      im.src = url; im.className = "h-40 rounded-xl object-cover cursor-zoom-in";
      im.title = p.caption || "";
      im.addEventListener("click", () => window.open(url, "_blank"));
      pbox.appendChild(im);
    }

    // events
    await renderEvents(id);
    const evForm = $("#event-form");
    $("#ev-type").innerHTML = ACT.TYPES
      .map((t) => `<option value="${t.key}">${t.icon} ${esc(t.label)}</option>`).join("");
    $("#ev-type").addEventListener("change", renderEventCascade);
    renderEventCascade();

    $("#add-event-btn").addEventListener("click", () => {
      evForm.classList.toggle("hidden");
      $("#ev-date").value = new Date().toISOString().slice(0, 10);
    });
    $("#ev-cancel").addEventListener("click", () => evForm.classList.add("hidden"));
    evForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = $("#ev-date").value;
      if (!d) return toast("Pick a date first");
      const btn = $("#event-form button:not([type=button])");
      btn.disabled = true;
      try {
        await data.addTimelineEntry(id, buildTimelineEntry(d));
        evForm.reset();
        evForm.classList.add("hidden");
        // The whole point of the rewrite: a mite check or treatment logged here
        // has to reach the queen's card, which reads its own summary tables.
        await refreshCardSummaries();
        await renderEvents(id);
        renderQueens();
        toast("Timeline entry added");
      } catch (err) {
        toast("Couldn't save that: " + (err.message || err), 4500);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---- Activity cascade -------------------------------------------------
  // Every extra control is rebuilt from the taxonomy each time the activity
  // changes, so adding an activity in js/activities.js needs no change here.
  function renderEventCascade() {
    const box = $("#ev-cascade");
    if (!box) return;
    const t = ACT.byKey[$("#ev-type").value];
    if (!t) { box.innerHTML = ""; return; }
    const sel = (id, lbl, opts, style) =>
      `<label class="block"><span class="lbl">${lbl}</span>
         <select class="inp" id="${id}" ${style ? `style="${style}"` : ""}>${opts}</select></label>`;

    if (t.special === "mite") {
      const opts = ACT.miteOptions()
        .map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
      box.innerHTML =
        sel("ev-mite-count", "Mites found", opts, "max-width:150px") +
        `<label class="block"><span class="lbl">Bees in sample</span>
           <div class="flex items-center gap-2">
             <!-- step must stay 1: with step="50" the browser silently refuses to
                  submit the default 300, because 300 isn't reachable from min=1.
                  readonly is the "are you sure" guard, lifted on confirmation. -->
             <input class="inp" id="ev-mite-sample" type="number" min="1" step="1" readonly
                    value="${ACT.MITE_SAMPLE_DEFAULT}" style="max-width:110px" />
             <span id="ev-mite-cup" class="text-xs text-hive-800/60 whitespace-nowrap"></span>
           </div></label>
         <div id="ev-mite-readout" class="text-sm pb-2 font-semibold"></div>`;
      const paint = () => {
        const raw = $("#ev-mite-count").value;
        const capped = raw === "20+";
        const n = capped ? ACT.MITE_CAP : parseInt(raw, 10);
        const sampleVal = $("#ev-mite-sample").value;
        const rate = ACT.miteRate(n, sampleVal);
        const band = ACT.miteBand(n, capped, sampleVal);
        const tone = band === "red" ? "text-red-600" : band === "amber" ? "text-amber-600" : "text-green-700";
        $("#ev-mite-readout").className = "text-sm pb-2 font-semibold " + tone;
        $("#ev-mite-readout").textContent =
          (rate == null ? "" : `${capped ? "≥" : ""}${rate.toFixed(1)}% infestation`) +
          (band === "red" ? " — TREAT" : band === "amber" ? " — watch" : "") +
          // Say which rule is being applied, so a count that would be red at a
          // half cup but isn't here doesn't look like a bug.
          (ACT.bandedByRate(sampleVal) && !capped ? " (judged by rate, not count)" : "");
      };
      // Scoop sizes, so the number means something to a beekeeper holding a cup.
      const sample = $("#ev-mite-sample");
      const paintCup = () => {
        const n = parseInt(sample.value, 10);
        const cup = ACT.CUPS[n];
        $("#ev-mite-cup").textContent = cup ? `(${cup})` : "(non-standard scoop)";
        $("#ev-mite-cup").className = "text-xs whitespace-nowrap " +
          (cup ? "text-hive-800/60" : "text-amber-600 font-medium");
      };

      // 300 is the standard, and the infestation percentage is only comparable
      // between hives if everyone uses the same scoop. So the field is editable
      // but not casually — one confirmation, then it behaves like any other box
      // for the rest of this entry.
      let sampleUnlocked = false;
      const askFirst = (e) => {
        if (sampleUnlocked) return;
        if (e) e.preventDefault();
        sample.blur();
        const go = confirm(
          "A half cup of bees — 300 — is the standard sample for an alcohol wash or " +
          "sugar roll, and the infestation percentage assumes it.\n\n" +
          "Change the sample size anyway?");
        if (!go) return;                 // stays locked; ask again on the next tap
        sampleUnlocked = true;
        sample.removeAttribute("readonly");
        sample.focus();
        sample.select();
      };
      sample.addEventListener("mousedown", askFirst);
      sample.addEventListener("touchstart", askFirst);
      sample.addEventListener("focus", askFirst);
      sample.addEventListener("keydown", askFirst);

      $("#ev-mite-count").addEventListener("change", paint);
      sample.addEventListener("input", () => { paint(); paintCup(); });
      sample.addEventListener("change", () => { paint(); paintCup(); });
      paint();
      paintCup();
      return;
    }

    let html = "";
    if (t.subs) {
      html += sel("ev-sub", "Type", t.subs.map((s) => `<option>${esc(s.label)}</option>`).join(""), "max-width:180px");
      html += sel("ev-detail", "Which", "", "max-width:200px");
    } else if (t.items) {
      html += sel("ev-detail", "Which", t.items.map((i) => `<option>${esc(i)}</option>`).join(""), "max-width:230px");
    }
    if (t.special === "percent") {
      html += `<label class="block"><span class="lbl">Result</span>
        <input class="inp" id="ev-value" type="number" min="0" max="100" step="1"
               placeholder="%" style="max-width:110px" /></label>`;
    }
    box.innerHTML = html;

    if (t.subs) {
      const fillDetail = () => {
        const chosen = t.subs.find((s) => s.label === $("#ev-sub").value) || t.subs[0];
        $("#ev-detail").innerHTML = chosen.items.map((i) => `<option>${esc(i)}</option>`).join("");
      };
      $("#ev-sub").addEventListener("change", fillDetail);
      fillDetail();
    }
  }

  // Turn the form into the shape addTimelineEntry() wants: a timeline row plus,
  // where one exists, the domain record that feeds the queen's summary card.
  function buildTimelineEntry(date) {
    const t = ACT.byKey[$("#ev-type").value];
    const note = $("#ev-note").value || null;
    const sub = $("#ev-sub") ? $("#ev-sub").value : null;
    const detail = $("#ev-detail") ? $("#ev-detail").value : null;
    const base = { event_date: date, event_type: t.key, event_subtype: sub, event_detail: detail, note };

    if (t.special === "mite") {
      const raw = $("#ev-mite-count").value;
      const capped = raw === "20+";
      const count = capped ? ACT.MITE_CAP : parseInt(raw, 10);
      const sample = parseInt($("#ev-mite-sample").value, 10) || ACT.MITE_SAMPLE_DEFAULT;
      return {
        ...base, value_num: count, event_detail: capped ? "20+" : String(count),
        // The scoop rides along on the timeline row so the entry can be banded
        // without going back to the inspections table to ask how many bees.
        event_subtype: String(sample),
        table: "inspections",
        record: {
          inspection_date: date, mite_check_date: date,
          mite_count: count, mite_count_capped: capped, mite_sample_size: sample,
          mite_wash_method: "alcohol wash", summary: `Mite check: ${capped ? "20+" : count} mites / ${sample} bees`,
          notes: note,
        },
      };
    }
    if (t.special === "percent") {
      const v = $("#ev-value").value === "" ? null : parseFloat($("#ev-value").value);
      return { ...base, value_num: v };
    }
    if (t.table === "treatments") {
      return { ...base, table: "treatments",
        record: { treatment_date: date, category: sub, product: detail, target: "varroa", notes: note } };
    }
    if (t.table === "feedings") {
      return { ...base, table: "feedings",
        record: { feed_date: date, category: sub, feed_type: detail, notes: note } };
    }
    if (t.table === "inspections") {
      return { ...base, table: "inspections",
        record: { inspection_date: date, notes: note, summary: t.label } };
    }
    return base;
  }

  async function renderEvents(id) {
    const ul = $("#events-list");
    const events = await data.listEvents(id);
    if (!events.length) { ul.innerHTML = `<li class="text-hive-800/40">No timeline entries yet.</li>`; return; }
    ul.innerHTML = events.map((ev) => {
      // Old rows stored a free-typed event_type; resolve() maps those onto the
      // new vocabulary so nothing already logged loses its label.
      const t = ACT.resolve(ev.event_type);
      const title = t ? t.label : (ev.event_type || "");
      const icon = t ? t.icon : "•";
      const bits = [];
      if (ev.event_subtype) bits.push(esc(ev.event_subtype));
      if (ev.event_detail) bits.push(esc(ev.event_detail));
      let chip = bits.length ? ` <span class="text-hive-800/70">${bits.join(" · ")}</span>` : "";
      if (t && t.special === "percent" && ev.value_num != null) chip += ` <b>${ev.value_num}%</b>`;
      if (t && t.special === "mite" && ev.value_num != null) {
        const capped = ev.event_detail === "20+";
        // event_subtype holds the sample size for a mite check. Older rows and
        // backfilled ones have none, which correctly falls back to count bands.
        const sample = parseInt(ev.event_subtype, 10);
        const band = ACT.miteBand(Number(ev.value_num), capped, sample);
        const tone = band === "red" ? "text-red-600" : band === "amber" ? "text-amber-600" : "text-green-700";
        const scoop = ACT.bandedByRate(sample) ? ` <span class="text-hive-800/50">/${sample}</span>` : "";
        chip = ` <span class="${tone} font-semibold">${capped ? "20+" : ev.value_num} mite${ev.value_num == 1 && !capped ? "" : "s"}${band === "red" ? " — TREAT" : ""}</span>${scoop}`;
      }
      return `
      <li class="flex gap-2 items-start group">
        <span class="text-honey-600 font-mono text-xs mt-0.5 w-24 shrink-0">${ev.event_date}</span>
        <span class="flex-1">${title ? `<b class="text-honey-800">${icon} ${esc(title)}</b>` : ""}${chip}${ev.note ? ` <span class="text-hive-800/60">${esc(ev.note)}</span>` : ""}</span>
        ${APIARIES.canWrite() ? `<button data-ev="${ev.id}" class="text-red-500 opacity-0 group-hover:opacity-100 text-xs">delete</button>` : ""}
      </li>`;
    }).join("");
    $$("[data-ev]", ul).forEach((b) => b.addEventListener("click", async () => {
      await data.deleteEvent(b.dataset.ev);
      await refreshCardSummaries();
      await renderEvents(id);
      renderQueens();
    }));
  }

  // ================= LINEAGE =================
  function renderLineage() {
    window.QT_LINEAGE.render(QUEENS, {
      container: currentLineageView === "tree" ? $("#lineage-tree") : $("#lineage-list"),
      view: currentLineageView,
      fit: lineageFit,
      onSelect: (id) => openDetail(id),
      label,
      ratingDots,
    });
  }
  let currentLineageView = "tree";
  let lineageFit = false;
  $("#lin-view-tree").addEventListener("click", () => setLineageView("tree"));
  $("#lin-view-list").addEventListener("click", () => setLineageView("list"));
  function setLineageView(v) {
    currentLineageView = v;
    $("#lineage-tree").classList.toggle("hidden", v !== "tree");
    $("#lineage-list").classList.toggle("hidden", v !== "list");
    $("#lin-view-tree").className = "px-4 py-2 text-sm font-medium " + (v === "tree" ? "bg-honey-500 text-white" : "bg-white text-honey-700");
    $("#lin-view-list").className = "px-4 py-2 text-sm font-medium " + (v === "list" ? "bg-honey-500 text-white" : "bg-white text-honey-700");
    $("#lin-fit").classList.toggle("hidden", v !== "tree"); // only the tree can be scaled
    renderLineage();
  }
  $("#lin-fit").addEventListener("click", () => {
    lineageFit = !lineageFit;
    $("#lin-fit").className = "px-3 py-2 text-sm font-medium rounded-lg border border-honey-300 " +
      (lineageFit ? "bg-honey-500 text-white border-honey-500" : "bg-white text-honey-700");
    renderLineage();
  });
  // Bands are packed to the container's width, so a rotate/resize needs a redraw.
  let linResizeT = null;
  window.addEventListener("resize", () => {
    if (currentTab !== "lineage" || currentLineageView !== "tree") return;
    clearTimeout(linResizeT);
    linResizeT = setTimeout(renderLineage, 200);
  });

  // ================= STATS =================
  function renderStats() {
    const total = QUEENS.length;
    const alive = QUEENS.filter((q) => q.status === "alive").length;
    const laying = QUEENS.filter((q) => q.mated_status === "laying").length;
    const avgLay = (() => {
      const v = QUEENS.map((q) => q.laying_pattern).filter(Boolean);
      return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "—";
    })();
    const cards = [
      ["Total queens", total, "🐝"],
      ["Alive", alive, "💚"],
      ["Currently laying", laying, "🥚"],
      ["Avg laying pattern", avgLay, "⭐"],
    ];
    $("#stats-grid").innerHTML = cards.map(([l, v, e]) => `
      <div class="bg-white card-shadow rounded-xl p-5">
        <div class="text-3xl">${e}</div>
        <div class="text-3xl font-bold text-honey-800 mt-1">${v}</div>
        <div class="text-sm text-hive-800/60">${l}</div>
      </div>`).join("");

    const byYear = {};
    QUEENS.forEach((q) => { const y = q.year || "Unknown"; byYear[y] = (byYear[y] || 0) + 1; });
    const years = Object.keys(byYear).sort();
    const max = Math.max(1, ...Object.values(byYear));
    $("#stats-byyear").innerHTML = `<h3 class="font-semibold text-honey-800 mb-3">Queens reared by year</h3>` +
      years.map((y) => `
        <div class="flex items-center gap-3 mb-2">
          <span class="w-16 text-sm text-hive-800/60">${y}</span>
          <div class="flex-1 bg-honey-100 rounded-full h-5 overflow-hidden">
            <div class="bg-honey-500 h-5" style="width:${(byYear[y]/max)*100}%"></div>
          </div>
          <span class="w-8 text-sm font-semibold text-honey-700">${byYear[y]}</span>
        </div>`).join("") || "<p class='text-hive-800/50'>No data yet.</p>";
  }

  // ================= HIVES & QR CODES =================
  // Base URL the QR codes point at — works wherever the app is hosted (GitHub Pages, etc.)
  function appBase() { return location.origin + location.pathname; }
  function hiveUrl(label) { return appBase() + "?hive=" + encodeURIComponent(label); }

  // Build an SVG QR code (crisp at any print size) for `text`, sized ~sizePx.
  function qrSvg(text, sizePx) {
    const qr = qrcode(0, "M");        // auto version, medium error-correction
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4;                 // quiet zone (modules)
    const cell = Math.max(2, Math.floor(sizePx / (count + margin * 2)));
    return qr.createSvgTag({ cellSize: cell, margin });
  }

  // Group queens into hives by their `current_hive` label (case-insensitive).
  function deriveHives() {
    const map = new Map();
    for (const q of QUEENS) {
      const h = (q.current_hive || "").trim();
      if (!h) continue;
      const key = h.toLowerCase();
      if (!map.has(key)) map.set(key, { label: h, queens: [] });
      map.get(key).queens.push(q);
    }
    const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    const hives = [...map.values()].map(({ label, queens }) => {
      const alive = queens.filter((q) => q.status === "alive").sort(byNewest);
      const any = [...queens].sort(byNewest);
      return { label, current: alive[0] || any[0], count: queens.length, aliveCount: alive.length };
    });
    hives.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
    return hives;
  }

  // The queen a scanned hive should open: the alive one (most recent), else most recent ever.
  function findHiveCurrentQueen(label) {
    const key = (label || "").trim().toLowerCase();
    const queens = QUEENS.filter((q) => (q.current_hive || "").trim().toLowerCase() === key);
    if (!queens.length) return null;
    const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    return queens.filter((q) => q.status === "alive").sort(byNewest)[0] || [...queens].sort(byNewest)[0];
  }

  function renderHives() {
    const grid = $("#hives-grid");
    const all = deriveHives();
    $("#hives-empty").classList.toggle("hidden", all.length !== 0);
    const term = ($("#hive-search").value || "").toLowerCase().trim();
    const hives = term
      ? all.filter((h) => (h.label + " " + (h.current ? h.current.queen_code + " " + (h.current.name || "") : "")).toLowerCase().includes(term))
      : all;
    grid.innerHTML = hives.map((h) => {
      const q = h.current;
      let svg = "";
      try { svg = qrSvg(hiveUrl(h.label), 104); } catch (e) { svg = "<span class='text-xs text-red-500'>QR error</span>"; }
      const sc = q ? (STATUS_COLORS[q.status] || "") : "";
      return `
      <div class="bg-white rounded-xl card-shadow p-4">
        <div class="flex items-start gap-3">
          <div class="hive-thumb w-16 h-16 rounded-lg bg-honey-100 flex items-center justify-center text-2xl shrink-0 bg-cover bg-center" ${q ? `data-hivethumb="${q.id}"` : ""}>🐝</div>
          <div class="min-w-0 flex-1">
            <div class="font-bold text-honey-800">Hive: ${esc(h.label)}</div>
            ${q
              ? `<div class="text-sm text-hive-800/70 truncate">${esc(q.queen_code)}${q.name ? " · " + esc(q.name) : ""}</div>
                 <div class="mt-1"><span class="text-xs px-2 py-0.5 rounded-full ${sc} capitalize">${esc(q.status || "")}</span></div>`
              : `<div class="text-sm text-hive-800/40">No queen assigned</div>`}
            <div class="text-xs text-hive-800/40 mt-1">${h.count} queen${h.count !== 1 ? "s" : ""} in history</div>
          </div>
          <div class="shrink-0">${svg}</div>
        </div>
        <div class="flex gap-2 mt-3">
          <button class="hive-open flex-1 text-sm border border-honey-200 hover:bg-honey-50 rounded-lg py-1.5" data-hive="${esc(h.label)}">Open</button>
          <button class="hive-qr flex-1 text-sm bg-honey-100 text-honey-700 hover:bg-honey-200 rounded-lg py-1.5" data-hive="${esc(h.label)}">▦ QR / Print</button>
        </div>
      </div>`;
    }).join("");
    $$(".hive-open", grid).forEach((b) => b.addEventListener("click", () => openHive(b.dataset.hive)));
    $$(".hive-qr", grid).forEach((b) => b.addEventListener("click", () => openQrModal(b.dataset.hive)));
    // Load each hive's photo (its current queen's primary photo) into the thumbnail.
    for (const h of hives) {
      if (h.current) loadPhotoInto(grid.querySelector(`[data-hivethumb="${h.current.id}"]`), h.current.id);
    }
  }

  // Fill an element's background with a queen's primary photo (used by hive cards).
  async function loadPhotoInto(el, queenId) {
    if (!el) return;
    try {
      const photos = await data.listPhotos(queenId);
      if (!photos.length) return;
      const primary = photos.find((p) => p.is_primary) || photos[0];
      const url = await data.photoUrl(primary.storage_path);
      if (url) { el.style.backgroundImage = `url('${url}')`; el.textContent = ""; }
    } catch (e) { /* keep the 🐝 fallback */ }
  }

  function openHive(label) {
    const q = findHiveCurrentQueen(label);
    if (!q) return toast(`No queen found in hive "${label}"`);
    openDetail(q.id);
  }

  // ---- QR modal ----
  let qrCurrentLabel = "";
  function openQrModal(label) {
    qrCurrentLabel = label;
    const url = hiveUrl(label);
    const q = findHiveCurrentQueen(label);
    $("#qr-hive-label").textContent = label;
    $("#qr-sub").textContent = q ? `Opens: ${q.queen_code}${q.name ? " · " + q.name : ""}` : "No queen assigned yet";
    $("#qr-url").textContent = url;
    let svg = "";
    try { svg = qrSvg(url, 224); } catch (e) { svg = "<span class='text-red-500 text-sm'>Couldn't render QR</span>"; }
    $("#qr-holder").innerHTML = svg;
    $("#qr-modal").classList.remove("hidden");
  }
  $("#qr-close").addEventListener("click", () => $("#qr-modal").classList.add("hidden"));
  $("#qr-modal").addEventListener("click", (e) => { if (e.target.id === "qr-modal") $("#qr-modal").classList.add("hidden"); });
  $("#qr-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(hiveUrl(qrCurrentLabel)); toast("Link copied"); }
    catch (e) { toast("Copy failed — long-press the link to copy"); }
  });
  $("#qr-print").addEventListener("click", () => printLabels([qrCurrentLabel], ($("#qr-print-size") || {}).value || "medium"));

  // ---- Printable label sheet ----
  // Sizes are in INCHES, not CSS pixels. Pixel sizes get rescaled by the print
  // dialog (and by device pixel ratio), which is why "small/medium/large" used
  // to come out the same on paper. Inches + an explicit @page box print at the
  // real measured size as long as the print dialog is left at 100% scale.
  const LABEL_SIZES = {
    small:  { key: "small",  w: 1.5,  qr: 1.2,  name: 12, hint: 7,  desc: "1.5 in" },
    medium: { key: "medium", w: 2.5,  qr: 2.0,  name: 18, hint: 9,  desc: "2.5 in" },
    large:  { key: "large",  w: 3.75, qr: 3.1,  name: 26, hint: 11, desc: "3.75 in" },
  };
  const PAGE_MARGIN_IN = 0.4;           // matches the @page rule below
  const GAP_IN = 0.2;
  function labelsPerPage(s) {
    const usableW = 8.5 - PAGE_MARGIN_IN * 2;
    const usableH = 11 - PAGE_MARGIN_IN * 2;
    const labelH = s.qr + 0.75;         // QR + name + hint + padding, approx
    const cols = Math.max(1, Math.floor((usableW + GAP_IN) / (s.w + GAP_IN)));
    const rows = Math.max(1, Math.floor((usableH + GAP_IN) / (labelH + GAP_IN)));
    return cols * rows;
  }

  function printLabels(labels, sizeKey) {
    const s = LABEL_SIZES[sizeKey] || LABEL_SIZES.medium;
    // Render the QR at a generous pixel density; CSS then scales the vector
    // down to the exact physical size, so it stays crisp on paper.
    const items = labels.map((l) => {
      let svg = "";
      try { svg = qrSvg(hiveUrl(l), 512); } catch (e) { svg = ""; }
      return `<div class="label"><div class="qr">${svg}</div><div class="name">Hive: ${esc(l)}</div><div class="hint">Scan to open this hive</div></div>`;
    }).join("");
    const w = window.open("", "_blank");
    if (!w) return toast("Allow pop-ups to print labels");
    const perPage = labelsPerPage(s);
    w.document.write(`<!doctype html><html><head><title>Hive QR labels — ${esc(s.desc)}</title><style>
      @page { size: letter portrait; margin: ${PAGE_MARGIN_IN}in; }
      *{box-sizing:border-box}
      html,body{margin:0;padding:0}
      body{font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#2b220f}
      .bar{background:#fff7e6;border:1px solid #e0b96a;border-radius:8px;padding:8px 12px;
           font-size:12px;color:#894b16;margin-bottom:${GAP_IN}in}
      .sheet{display:flex;flex-wrap:wrap;gap:${GAP_IN}in;align-items:flex-start}
      .label{border:2px dashed #e0b96a;border-radius:0.12in;padding:0.12in;
             width:${s.w}in;text-align:center;break-inside:avoid;page-break-inside:avoid}
      /* Fixed physical box for the QR; the SVG scales into it via its viewBox. */
      .qr{width:${s.qr}in;height:${s.qr}in;margin:0 auto}
      .qr svg{width:100%;height:100%;display:block}
      .name{font-size:${s.name}pt;font-weight:800;margin-top:0.06in;color:#894b16;
            line-height:1.1;word-break:break-word}
      .hint{font-size:${s.hint}pt;color:#999;margin-top:0.02in}
      @media print{
        .bar{display:none}
        .label{border-color:#bbb}
      }
    </style></head><body>
    <div class="bar"><b>${labels.length} label${labels.length !== 1 ? "s" : ""}</b> at ${esc(s.desc)} wide
      (about ${perPage} per page). In the print dialog set <b>Scale: 100%</b> (not "Fit to page")
      so the tags come out at the size shown.</div>
    <div class="sheet">${items}</div>
    <script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
    </body></html>`);
    w.document.close();
  }

  $("#hive-search").addEventListener("input", renderHives);

  // ---- Scan a tag ----
  // Scanning is a read action, so it's available to read-only members too.
  // A scanned tag behaves exactly like following its ?hive= link.
  function scannedHive(label) {
    const q = findHiveCurrentQueen(label);
    if (q) { switchTab("queens"); openDetail(q.id); return; }
    switchTab("hives");
    const known = deriveHives().some((h) => h.label.toLowerCase() === String(label).trim().toLowerCase());
    toast(known
      ? `Hive "${label}" has no queen assigned yet`
      : `Scanned "${label}" — no hive by that name in this apiary`, 4000);
  }
  $("#hives-scan").addEventListener("click", () => {
    if (!window.QT_SCAN) return toast("Scanner didn't load — try reloading");
    window.QT_SCAN.open({
      onHive: scannedHive,
      onQueen: (id) => { const q = byId(id); if (q) { switchTab("queens"); openDetail(q.id); } else toast("That queen isn't in this apiary"); },
      onUrl: (url) => toast("That's not a Queen Tracker tag: " + url, 4000),
    });
  });

  $("#hives-print-all").addEventListener("click", () => {
    const labels = deriveHives().map((h) => h.label);
    if (!labels.length) return toast("No hives to print yet");
    printLabels(labels, ($("#hives-print-size") || {}).value || "medium");
  });

  // ---- Deep link: open a hive/queen from a scanned QR (?hive= / ?queen=) ----
  function handleDeepLink() {
    const params = new URLSearchParams(location.search);
    const hive = params.get("hive");
    const queen = params.get("queen");
    if (!hive && !queen) return;
    if (queen) {
      const q = byId(queen);
      if (q) openDetail(q.id); else toast("That queen link wasn't found");
    } else if (hive) {
      const q = findHiveCurrentQueen(hive);
      if (q) { switchTab("queens"); openDetail(q.id); }
      else { switchTab("hives"); toast(`No queen is assigned to hive "${hive}" yet`); }
    }
    // Tidy the URL so a refresh doesn't re-trigger and it looks clean
    history.replaceState(null, "", appBase());
  }

  // ================= VOICE NOTES =================
  let mediaRecorder = null, recChunks = [], recTimer = null, recSeconds = 0, recStream = null;
  let voiceMeta = { queen_id: null, hive_label: null };

  function fmtTime(s) { return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function pickMime() {
    const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    if (!window.MediaRecorder) return "";
    for (const c of cands) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) {} }
    return "";
  }
  function setRecUI(recording) {
    const b = $("#voice-record");
    b.textContent = recording ? "■" : "●";
    b.classList.toggle("animate-pulse", recording);
  }

  function openVoiceModal(queenId, hiveLabel) {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return toast("This browser can't record audio. Try Chrome or Safari on your phone.", 4000);
    }
    voiceMeta = { queen_id: queenId, hive_label: hiveLabel || null };
    const q = queenId ? byId(queenId) : null;
    $("#voice-hive").textContent = hiveLabel || (q ? q.queen_code : "");
    $("#voice-status").textContent = "Tap the red button and describe the hive out loud.";
    $("#voice-timer").textContent = "0:00";
    $("#voice-record").disabled = false;
    setRecUI(false);
    $("#voice-modal").classList.remove("hidden");
  }
  function closeVoiceModal() {
    if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
    $("#voice-modal").classList.add("hidden");
  }

  $("#voice-close").addEventListener("click", closeVoiceModal);
  $("#voice-modal").addEventListener("click", (e) => { if (e.target.id === "voice-modal") closeVoiceModal(); });

  $("#voice-record").addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") { stopRecording(); return; }
    await startRecording();
  });

  async function startRecording() {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      $("#voice-status").textContent = "Microphone permission was blocked — enable it and try again.";
      return;
    }
    const mime = pickMime();
    recChunks = [];
    try {
      mediaRecorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      mediaRecorder = new MediaRecorder(recStream);
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.start();
    recSeconds = 0; $("#voice-timer").textContent = "0:00";
    recTimer = setInterval(() => { recSeconds++; $("#voice-timer").textContent = fmtTime(recSeconds); }, 1000);
    setRecUI(true);
    $("#voice-status").textContent = "Recording… tap again to stop.";
  }

  function stopRecording() {
    try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch (e) {}
    clearInterval(recTimer);
    if (recStream) recStream.getTracks().forEach((t) => t.stop());
    setRecUI(false);
  }

  async function onRecordingStop() {
    const type = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
    const blob = new Blob(recChunks, { type });
    if (!blob.size) { $("#voice-status").textContent = "Didn't catch anything — try again."; return; }
    $("#voice-status").textContent = "Uploading & transcribing… this can take a few seconds.";
    $("#voice-record").disabled = true;
    try {
      const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
      const audio_path = await data.uploadAudio(voiceMeta.queen_id, voiceMeta.hive_label, blob, ext);
      const res = await data.transcribeVoice({ audio_path, queen_id: voiceMeta.queen_id, hive_label: voiceMeta.hive_label });
      $("#voice-modal").classList.add("hidden");
      openReviewCard(res.parsed || {}, res.transcript || "", { ...voiceMeta, audio_path });
    } catch (e) {
      $("#voice-status").textContent = "Failed: " + (e.message || e);
      $("#voice-record").disabled = false;
    }
  }

  // ---- Review & confirm card ----
  const REVIEW_FIELDS = {
    inspection: [
      ["inspection_date", "Date", "date"], ["queen_seen", "Queen seen", "bool"], ["eggs_seen", "Eggs seen", "bool"],
      ["brood_pattern", "Brood pattern (1-5)", "num"], ["temperament", "Temperament (1-5)", "num"],
      ["population", "Population", "text"], ["stores", "Stores", "text"], ["space", "Space", "text"],
      ["queen_cells", "Queen cells", "bool"], ["swarm_signs", "Swarm signs", "bool"],
      ["mite_check_date", "Mite wash date", "date"], ["mite_count", "Mite count (# found)", "int"],
      ["mite_sample_size", "Bees in sample (e.g. 300)", "int"], ["mite_wash_method", "Wash method", "text"],
      ["mites", "Mite notes", "text"], ["pests_disease", "Pests / disease", "text"],
      ["actions", "Actions taken", "text"], ["notes", "Notes", "text"],
    ],
    treatment: [
      ["treatment_date", "Date", "date"], ["product", "Product", "text"], ["target", "Target", "text"],
      ["dose", "Dose", "text"], ["method", "Method", "text"], ["notes", "Notes", "text"],
    ],
    feeding: [
      ["feed_date", "Date", "date"], ["feed_type", "Feed type", "text"], ["amount", "Amount", "text"], ["notes", "Notes", "text"],
    ],
  };
  const DATE_KEY = { inspection: "inspection_date", treatment: "treatment_date", feeding: "feed_date" };
  let reviewState = { kind: "inspection", meta: {}, transcript: "", parsed: {} };

  function openReviewCard(parsed, transcript, meta) {
    const kind = (parsed.category === "treatment" || parsed.category === "feeding") ? parsed.category : "inspection";
    reviewState = { kind, meta, transcript, parsed: parsed || {} };
    renderReviewCard();
    $("#review-modal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }
  function closeReview() { $("#review-modal").classList.add("hidden"); document.body.style.overflow = ""; }
  $("#review-close").addEventListener("click", closeReview);
  $("#review-modal").addEventListener("click", (e) => { if (e.target.id === "review-modal") closeReview(); });

  function renderReviewCard() {
    const kind = reviewState.kind;
    const dateKey = DATE_KEY[kind];
    const today = new Date().toISOString().slice(0, 10);
    const sub = reviewState.parsed[kind] || {};
    const meta = reviewState.meta;
    const q = meta.queen_id ? byId(meta.queen_id) : null;
    const catBtn = (k, lbl) => `<button data-cat="${k}" class="px-3 py-1.5 rounded-lg text-sm font-medium ${kind === k ? "bg-honey-500 text-white" : "bg-honey-100 text-honey-700"}">${lbl}</button>`;
    const fieldHtml = REVIEW_FIELDS[kind].map(([key, lbl, type]) => {
      const val = key === dateKey ? (sub[dateKey] || today) : sub[key];
      if (type === "bool") {
        const v = val === true ? "yes" : val === false ? "no" : "";
        return `<label class="block"><span class="lbl">${lbl}</span>
          <select class="inp" data-f="${key}" data-t="bool">
            <option value="" ${v === "" ? "selected" : ""}>—</option>
            <option value="yes" ${v === "yes" ? "selected" : ""}>Yes</option>
            <option value="no" ${v === "no" ? "selected" : ""}>No</option>
          </select></label>`;
      }
      const inputType = type === "date" ? "date" : (type === "num" || type === "int") ? "number" : "text";
      const minmax = type === "num" ? 'min="1" max="5"' : type === "int" ? 'min="0"' : "";
      return `<label class="block"><span class="lbl">${lbl}</span>
        <input class="inp" data-f="${key}" data-t="${type}" type="${inputType}" ${minmax} value="${val == null ? "" : esc(String(val))}" /></label>`;
    }).join("");
    $("#review-body").innerHTML = `
      <div class="flex gap-2 mb-4">${catBtn("inspection", "🔍 Inspection")}${catBtn("treatment", "💊 Treatment")}${catBtn("feeding", "🍯 Feeding")}</div>
      <p class="text-xs text-hive-800/50 mb-3">${q ? `Hive <b>${esc(meta.hive_label || "—")}</b> · ${esc(q.queen_code)}` : esc(meta.hive_label || "")} — AI-filled from your voice note. Edit anything before saving.</p>
      <div class="grid sm:grid-cols-2 gap-3">${fieldHtml}</div>
      <div class="mt-4">
        <div class="text-honey-700 font-semibold text-xs uppercase mb-1">What you said</div>
        <p class="text-sm text-hive-800/70 bg-honey-50 rounded-lg p-2 whitespace-pre-wrap">${esc(reviewState.transcript || "(no transcript)")}</p>
      </div>
      <div class="flex gap-2 justify-end mt-5 pt-3 border-t border-honey-100">
        <button id="review-discard" class="rounded-lg px-4 py-2 border border-honey-200 hover:bg-honey-50">Discard</button>
        <button id="review-save" class="bg-honey-500 hover:bg-honey-600 text-white font-semibold rounded-lg px-5 py-2 capitalize">Save ${kind}</button>
      </div>`;
    $$("#review-body [data-cat]").forEach((b) => b.addEventListener("click", () => {
      captureReviewEdits();
      reviewState.kind = b.dataset.cat;
      renderReviewCard();
    }));
    $("#review-discard").addEventListener("click", closeReview);
    $("#review-save").addEventListener("click", saveReview);
  }

  function captureReviewEdits() {
    const sub = (reviewState.parsed[reviewState.kind] = reviewState.parsed[reviewState.kind] || {});
    $$("#review-body [data-f]").forEach((el) => {
      const k = el.dataset.f, t = el.dataset.t, v = el.value;
      if (t === "bool") sub[k] = v === "" ? null : v === "yes";
      else if (t === "num" || t === "int") sub[k] = v === "" ? null : parseInt(v, 10);
      else sub[k] = v === "" ? null : v;
    });
  }

  async function saveReview() {
    captureReviewEdits();
    const btn = $("#review-save");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const kind = reviewState.kind;
      const dateKey = DATE_KEY[kind];
      const row = { ...(reviewState.parsed[kind] || {}) };
      if (!row[dateKey]) row[dateKey] = new Date().toISOString().slice(0, 10);
      // If a mite count was captured but no separate wash date given, it happened
      // during this inspection.
      if (kind === "inspection" && row.mite_count != null && !row.mite_check_date) {
        row.mite_check_date = row.inspection_date;
      }
      if (reviewState.parsed.summary && !row.summary) row.summary = reviewState.parsed.summary;
      await data.saveVoiceRecord(kind, row, {
        queen_id: reviewState.meta.queen_id, hive_label: reviewState.meta.hive_label,
        transcript: reviewState.transcript, audio_path: reviewState.meta.audio_path,
      });
      toast("Saved " + kind + " 🐝");
      closeReview();
      if (detailId) await renderEvents(detailId);
    } catch (e) {
      toast("Save failed: " + (e.message || e), 4000);
    } finally {
      btn.disabled = false; btn.textContent = "Save " + reviewState.kind;
    }
  }

  // ================= EXPORT =================
  // The wizard itself lives in js/export.js; this just hands it the data.
  function openExport() {
    if (!QUEENS.length) return toast("Nothing to export yet");
    if (!window.QT_EXPORT) return toast("Export module didn't load — try reloading");
    window.QT_EXPORT.open({
      queens: QUEENS,
      toast,
      listAll: (table) => data.listAll(table),
    });
  }
  $("#export-close").addEventListener("click", () => window.QT_EXPORT.close());
  $("#export-modal").addEventListener("click", (e) => {
    if (e.target.id === "export-modal") window.QT_EXPORT.close();
  });

  // ================= IMPORT =================
  // Minimal RFC-4180-ish CSV parser (handles quotes, commas & newlines in fields).
  function parseCSV(text) {
    const rows = [];
    let field = "", row = [], inQ = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ",") { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += ch; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function csvToObjects(text) {
    const rows = parseCSV(text).filter((r) => !(r.length === 1 && r[0] === ""));
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
      const o = {}; headers.forEach((h, idx) => (o[h] = r[idx] == null ? "" : r[idx])); return o;
    });
  }

  $("#menu-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      let rows;
      const looksJson = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text);
      if (looksJson) {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : (parsed.queens || [parsed]);
      } else {
        rows = csvToObjects(text);
      }
      if (!rows || !rows.length) return toast("Nothing to import from that file");
      if (!confirm(`Import ${rows.length} record(s) from "${file.name}"?\n\nRecords that share an ID with an existing queen will be updated; the rest are added new.`)) return;
      toast("Importing…");
      const res = await data.importQueens(rows);
      await refresh();
      toast(`Imported ✓  ${res.restored} restored, ${res.added} added${res.skipped ? ", " + res.skipped + " skipped" : ""}`, 3500);
    } catch (err) {
      toast("Import failed: " + (err.message || err), 5000);
    }
  });

  // close modals on backdrop click / escape
  [formModal, detailModal].forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) { m.classList.add("hidden"); document.body.style.overflow = ""; } }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      ["#form-modal", "#detail-modal", "#qr-modal", "#voice-modal", "#review-modal"].forEach((s) => $(s).classList.add("hidden"));
      document.body.style.overflow = "";
    }
  });
})();
