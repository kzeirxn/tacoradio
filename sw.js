// Caches the app itself so it still opens without a connection.
// The stream and the now-playing feed live on another domain and always go to the network.
const CACHE = 'taco-music-v12';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './admin.js',
  './vendor/js-yaml.min.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './fonts/bricolage-grotesque-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES.map((file) => new Request(file, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const key = request.mode === 'navigate' ? './index.html' : request;

  // Network first, checking with the server even if the browser has a copy, so the page and its
  // scripts always come from the same version of the app. The cache is for when there's no connection.
  event.respondWith(
    fetch(request.url, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy));
        }
        return response;
      })
      .catch(() => caches.match(key, { ignoreSearch: true })),
  );
});
