// Queen Tracker service worker — offline app shell + CDN caching.
// Bump CACHE when you change any precached file to force an update.
const CACHE = "qt-cache-v6";

// Paths are relative to the SW scope, so this works under /queen-tracker/ on
// GitHub Pages and at the root inside the native app.
const APP_SHELL = [
  "./",
  "index.html",
  "privacy.html",
  "manifest.webmanifest",
  "js/config.js",
  "js/biometric.js",
  "js/supabaseClient.js",
  "js/apiaries.js",
  "js/lineage.js",
  "js/export.js",
  "js/scanner.js",
  "js/app.js",
  "js/vendor/qrcode-generator.js",
  "js/vendor/jsqr.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

// CDN libraries we want available offline (cross-origin, cached opaquely).
const RUNTIME_HOSTS = ["cdn.tailwindcss.com", "cdn.jsdelivr.net"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; use individual puts so one miss can't abort install.
      .then((cache) => Promise.allSettled(APP_SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache writes / auth POSTs

  const url = new URL(req.url);

  // NEVER intercept Supabase or a transcription provider — auth, data, audio
  // and transcription must always be live and are user-specific.
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("openai.com") || url.hostname.endsWith("groq.com")) return;

  // App navigations (including deep links like ?hive=S-1): serve the cached
  // shell when offline so the app still boots.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("index.html") || caches.match("./"))
    );
    return;
  }

  // Same-origin assets: cache-first, then network (and cache the result).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Known CDN libs: stale-while-revalidate.
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
