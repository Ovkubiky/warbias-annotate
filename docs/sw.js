/* Offline shell: network first, cache as fallback, so updates arrive at once and the page still opens without a connection.
 * Only GET requests are touched; calls to the Apps Script backend are POSTs and go straight to the network. */
const CACHE = "wb-shell-v1";
const SHELL = ["./", "index.html", "styles.css", "config.js", "logic.js", "sample-data.js", "api.js", "app.js", "meadow.js", "onboarding.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || !/^https?:/.test(req.url)) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: req.mode === "navigate" }).then(r => r || caches.match("index.html"))));
});
