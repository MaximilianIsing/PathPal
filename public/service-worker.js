const CACHE_NAME = 'path-pal-v1.23';
const urlsToCache = [
  '/',
  '/index.html',
  '/profile.html',
  '/odds.html',
  '/simulator.html',
  '/explorer.html',
  '/career.html',
  '/activities.html',
  '/planner.html',
  '/messages.html',
  '/saved.html',
  '/team.html',
  '/account.html',
  '/essay-assistant.html',
  '/scholarships.html',
  '/css/style.css',
  '/js/app.js',
  '/js/api.js',
  '/manifest.json',
  '/media/logo/logo256x256.png',
  '/media/fonts/Arvo/Arvo-Regular.ttf',
  '/media/fonts/Arvo/Arvo-Bold.ttf'
];

// Install service worker - skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting(); // Activate new service worker immediately, don't wait
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(urlsToCache);
      })
  );
});

const LANDING_VIDEO_URL = '/media/background/landing.webm';
const LANDING_VIDEO_CACHE = 'landing-video';

// Fetch event - use stale-while-revalidate for faster updates
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isLandingVideo = url.includes('landing.webm');

  // For the intro video: serve from dedicated cache so signup/login get it without re-fetch (avoids Range-request cache mismatch)
  if (isLandingVideo && event.request.method === 'GET') {
    event.respondWith(
      caches.open(LANDING_VIDEO_CACHE).then((cache) => {
        return cache.match(new Request(url, { method: 'GET' })).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((networkResponse) => {
            if (networkResponse.ok && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              cache.put(new Request(url, { method: 'GET' }), clone).catch(() => {});
            }
            return networkResponse;
          });
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        // Fetch from network in background to update cache
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          // Cache API only supports GET (and HEAD); do not cache POST/PUT/etc.
          const canCache = event.request.method === 'GET' &&
            networkResponse.status === 200 && networkResponse.ok;
          if (canCache) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone).catch((err) => {
                console.warn('Failed to cache response:', err);
              });
            });
          }
          return networkResponse;
        }).catch(() => {
          // Network failed, ignore (we'll use cache)
        });
        
        // Return cached version immediately if available, otherwise wait for network
        if (cachedResponse) {
          // Don't wait for network - return cache immediately, update in background
          fetchPromise; // Fire and forget
          return cachedResponse;
        }
        // No cache, wait for network
        return fetchPromise;
      })
  );
});

// Activate event - claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all([
        // Delete old caches
        Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME && cacheName !== LANDING_VIDEO_CACHE) {
              return caches.delete(cacheName);
            }
          })
        ),
        // Claim all clients immediately (so new SW takes control right away)
        self.clients.claim()
      ]);
    })
  );
});

