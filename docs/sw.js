'use strict';

/*
 * Service worker de la PWA.
 * Solo cachea la interfaz (mismo origen, GitHub Pages). El backend de
 * emparejamiento y el túnel del PC son otro origen y nunca se interceptan.
 */
const VERSION = 'jd-control-pwa-v1';
const SHELL = [
  './',
  './index.html',
  './mobile.js',
  './manifest.webmanifest',
  './fonts/RBNo2.1-Black.otf',
  './fonts/LICENSE-RBNo2.1.txt',
  './apple-touch-icon.png',
  './favicon-32.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navegación: red primero (para recibir la última versión), caché si falla.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Estáticos: caché primero y actualización en segundo plano.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
