// Pal Lab service worker — hand-rolled, no build step, no workbox.
//
// WHY hand-rolled: the web build ships as a static bundle (`vite build --mode
// web`) to pal-lab.pages.dev. All we want from a SW is (1) an installable PWA
// and (2) an offline shell so a returning visitor still gets the app when the
// network is gone. That is a few caching rules — not worth a plugin + workbox
// runtime, and adding one would violate the no-new-deps constraint for this
// slice. Everything below is intentionally minimal.
//
// HEADERS NOTE: `app/public/_headers` sets COOP/COEP (required for the wasm
// worker's SharedArrayBuffer / cross-origin isolation). A cached `Response`
// carries its original headers verbatim, so serving from cache preserves the
// COOP/COEP the edge sent on the first fetch — we never synthesize responses or
// strip headers here, which would silently break cross-origin isolation.

// Bump this literal whenever the caching STRATEGY below changes. `activate`
// deletes every `pal-lab-*` cache that is not the current one, so a version
// bump cleanly evicts a stale strategy's entries on the next activation.
const CACHE = "pal-lab-v1";

// The offline shell. The app is a SPA: any navigation resolves to index.html
// ("/"), which then boots and hydrates from the (separately cached) hashed
// assets. Precaching just "/" is enough to render offline.
const SHELL = "/";

// install: precache the app shell, then take over ASAP.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(SHELL)),
  );
  // Activate this SW without waiting for existing tabs to close.
  self.skipWaiting();
});

// activate: drop caches from older strategy versions, then claim open clients.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("pal-lab-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// fetch: three rules, GET only. Non-GET (there are none in this static app, but
// be safe) falls straight through to the network untouched.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // (a) Content-hashed build assets (`/assets/*`) are immutable — the hash in
  // the filename changes when the content does. Cache-first is safe and fast;
  // populate the cache on the first (miss) fetch.
  if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          // Clone before caching: a Response body is a one-shot stream, so the
          // copy we store must be taken before the original is returned.
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        });
      }),
    );
    return;
  }

  // (b) Navigations (loading the page / SPA entry): network-first so a fresh
  // deploy is picked up immediately, falling back to the cached shell ("/")
  // when offline. `req.mode === "navigate"` marks top-level document loads.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(SHELL)),
    );
    return;
  }

  // (c) Everything else (fonts, images, wasm, map data, …): plain network
  // passthrough. Not worth caching here — most are large and the browser HTTP
  // cache already handles repeat loads.
});
