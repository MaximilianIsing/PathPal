const CACHE_NAME = 'path-pal-v1.18';
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

// Fetch event - use stale-while-revalidate for faster updates
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        // Fetch from network in background to update cache
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          // Update cache with new response
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
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
            if (cacheName !== CACHE_NAME) {
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

