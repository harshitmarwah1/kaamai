var CACHE_NAME = "kaamai-shell-v3";
var PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./vendor/supabase.min.js",
  "./sync.js",
  "./app.js",
  "./manifest.json",
  "./content/curriculum.json",
  "./fonts/baloo2-600.woff2",
  "./fonts/baloo2-700.woff2",
  "./fonts/baloo2-800.woff2",
  "./fonts/mulish-400.woff2",
  "./fonts/mulish-600.woff2",
  "./fonts/mulish-700.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never intercept cross-origin (e.g. Gemini links)

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () {
        return cached || Response.error();
      });
      return cached || network;
    })
  );
});
