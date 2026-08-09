// ---------------------------------------------------------------------------
//  Queen Tracker — in-app QR scanner
//
//  Point the phone at a hive tag and it opens that hive. Two decoders:
//
//    1. BarcodeDetector — native, hardware-accelerated, costs almost no battery.
//       Chrome and Android WebView have it; Safari does not.
//    2. jsQR — vendored in js/vendor/jsqr.js. Pure JS, works everywhere, and
//       critically works with no signal, which is the whole point out in a yard.
//
//  We never upload a frame anywhere. The camera stream is decoded on the device
//  and torn down the moment the overlay closes — including when the phone
//  locks or the app is backgrounded, so the camera light can't be left on.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

  let stream = null;        // MediaStream while open
  let track = null;         // the live video track (for torch)
  let detector = null;      // BarcodeDetector instance, when supported
  let raf = 0;              // requestAnimationFrame handle
  let canvas = null, cctx = null;
  let handlers = {};        // { onHive, onQueen, onUrl, toast }
  let busy = false;         // one scan fires one action
  let lastTick = 0;
  let facing = "environment";
  let torchOn = false;

  // ---- what did we just scan? ---------------------------------------------
  // Our own tags are full URLs with ?hive=. We also accept ?queen=, and a bare
  // string, because people write hive names on tape with a marker and someone
  // will eventually generate a plain-text QR of just "S-1".
  function interpret(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s) || s.startsWith("?") || s.startsWith("/")) {
      try {
        const u = new URL(s, location.href);
        const hive = u.searchParams.get("hive");
        if (hive) return { kind: "hive", value: hive };
        const queen = u.searchParams.get("queen");
        if (queen) return { kind: "queen", value: queen };
        return { kind: "url", value: u.href };
      } catch (e) { /* not a URL after all — fall through */ }
    }
    // Anything short and label-shaped is treated as a hive name.
    if (s.length <= 40 && !/\s{2,}/.test(s)) return { kind: "hive", value: s };
    return { kind: "url", value: s };
  }

  // ---- decoding -----------------------------------------------------------
  async function decodeFrame(video) {
    if (detector) {
      try {
        const found = await detector.detect(video);
        if (found && found.length) return found[0].rawValue;
        return null;
      } catch (e) {
        detector = null;              // fall back to jsQR for the rest of the session
      }
    }
    if (typeof window.jsQR !== "function") return null;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    // Downscale: jsQR on a full 1080p frame is far slower than it needs to be,
    // and a QR that's too small to read at 640px wide is too small to read.
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (!canvas) { canvas = document.createElement("canvas"); cctx = canvas.getContext("2d", { willReadFrequently: true }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    cctx.drawImage(video, 0, 0, w, h);
    const img = cctx.getImageData(0, 0, w, h);
    const res = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
    return res && res.data ? res.data : null;
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (busy) return;
    const now = performance.now();
    if (now - lastTick < 120) return;     // ~8 scans a second is plenty
    lastTick = now;
    const video = el("scan-video");
    if (!video || video.readyState < 2) return;
    busy = true;
    decodeFrame(video)
      .then((text) => {
        if (!text) { busy = false; return; }
        const hit = interpret(text);
        if (!hit) { busy = false; return; }
        succeed(hit);
      })
      .catch(() => { busy = false; });
  }

  function succeed(hit) {
    // Short vibration is the "yes, got it" a beekeeper in gloves can feel.
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* ignore */ }
    const frame = el("scan-frame");
    if (frame) frame.classList.add("scan-hit");
    setTimeout(() => {
      close();
      if (hit.kind === "hive" && handlers.onHive) handlers.onHive(hit.value);
      else if (hit.kind === "queen" && handlers.onQueen) handlers.onQueen(hit.value);
      else if (handlers.onUrl) handlers.onUrl(hit.value);
    }, 160);
  }

  // ---- camera -------------------------------------------------------------
  function setHint(text, tone) {
    const h = el("scan-hint");
    if (!h) return;
    h.textContent = text;
    h.className = "text-sm px-3 py-2 rounded-lg inline-block " +
      (tone === "error" ? "bg-red-600/90 text-white" : "bg-black/60 text-white");
  }

  async function startCamera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      const name = (e && e.name) || "";
      setHint(
        name === "NotAllowedError"
          ? "Camera access was blocked. Allow the camera for this site in your browser settings, then try again."
          : name === "NotFoundError"
            ? "No camera found on this device."
            : "Couldn't start the camera: " + (e.message || name),
        "error"
      );
      return false;
    }
    const video = el("scan-video");
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    try { await video.play(); } catch (e) { /* autoplay policies; the stream still renders */ }
    track = stream.getVideoTracks()[0] || null;

    // Torch, only where the hardware and browser both admit to having one.
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    el("scan-torch").classList.toggle("hidden", !caps || !("torch" in caps));
    torchOn = false;
    el("scan-torch").textContent = "🔦 Light off";
    return true;
  }

  function stopCamera() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (stream) { stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } }); }
    stream = null;
    track = null;
    const video = el("scan-video");
    if (video) { try { video.pause(); } catch (e) { /* ignore */ } video.srcObject = null; }
  }

  // ---- open / close -------------------------------------------------------
  async function open(opts) {
    handlers = opts || {};
    busy = false;
    facing = "environment";
    const modal = el("scan-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    const frame = el("scan-frame");
    if (frame) frame.classList.remove("scan-hit");
    setHint("Point the camera at a hive tag");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setHint("This browser can't reach the camera. Use the hive list, or open the tag's link directly.", "error");
      return;
    }

    // Prefer the native decoder when it really supports QR.
    detector = null;
    try {
      if ("BarcodeDetector" in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      }
    } catch (e) { detector = null; }

    if (await startCamera()) {
      lastTick = 0;
      raf = requestAnimationFrame(loop);
    }
  }

  function close() {
    stopCamera();
    busy = false;
    const modal = el("scan-modal");
    if (modal) modal.classList.add("hidden");
    document.body.style.overflow = "";
  }

  function isOpen() {
    const modal = el("scan-modal");
    return !!modal && !modal.classList.contains("hidden");
  }

  // ---- wiring -------------------------------------------------------------
  function wire() {
    const closeBtn = el("scan-close");
    if (!closeBtn) return;                 // markup missing — nothing to wire

    closeBtn.addEventListener("click", close);

    el("scan-flip").addEventListener("click", async () => {
      facing = facing === "environment" ? "user" : "environment";
      if (await startCamera()) { busy = false; }
    });

    el("scan-torch").addEventListener("click", async () => {
      if (!track || !track.applyConstraints) return;
      torchOn = !torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        el("scan-torch").textContent = torchOn ? "🔦 Light on" : "🔦 Light off";
      } catch (e) {
        torchOn = false;
        setHint("This camera won't let the app control the light.", "error");
      }
    });

    el("scan-manual").addEventListener("click", async () => {
      // In-app prompt so the sheet is titled Queen Tracker rather than stamped
      // with the domain; native prompt() only if the dialog module didn't load.
      const label = window.QT_DIALOG
        ? await window.QT_DIALOG.prompt("Hive name (as written on the tag):",
            { placeholder: "e.g. S-1", confirmText: "Open hive" })
        : prompt("Hive name (as written on the tag):");
      if (label == null) return;
      const v = label.trim();
      if (!v) return;
      close();
      if (handlers.onHive) handlers.onHive(v);
    });

    // Escape closes it on a laptop; leaving the tab or locking the phone kills
    // the stream so the camera indicator never lingers.
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) close(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden && isOpen()) close(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  window.QT_SCAN = { open, close, isOpen, _interpret: interpret, _decodeFrame: decodeFrame };
})();
