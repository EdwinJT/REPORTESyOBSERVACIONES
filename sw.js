/**
 * Service Worker Offline-First (M3 — PWA Instalable y Modo Sin Conexión)
 * Compatible con Workbox generateSW / registerType: 'prompt'
 * Precachea el App Shell completo (HTML, JS, CSS, íconos y manifest) para que la app
 * abra en Modo Avión (Escenario P5) tras cerrarse completamente.
 */

const CACHE_VERSION = 'v1.9.47-fix-miniaturas-historial-pdf';
const APP_SHELL_CACHE = `mineria-pwa-appshell-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './supabase_setup.sql',
  './public/pwa-192x192.png',
  './public/pwa-512x512.png',
  './public/apple-touch-icon.png',
  './src/main.js',
  './src/App.js',
  './src/index.css',
  './src/config/supabaseClient.js',
  './src/db/localDb.js',
  './src/db/storageManager.js',
  './src/services/equipmentService.js',
  './src/services/imageCompressor.js',
  './src/services/pwaManager.js',
  './src/services/authService.js',
  './src/services/connectivity.js',
  './src/services/syncQueue.js',
  './src/services/excelExporter.js',
  './src/utils/codeNormalizer.js',
  './src/utils/datePeru.js',
  './src/components/CapturaReporte/CapturaReporte.js',
  './src/components/CapturaReporte/demoSeed.js',
  './src/components/MisReportes/MisReportes.js',
  './src/components/PwaBanner/PwaBanner.js',
  './src/components/Auth/Auth.js',
  './src/components/SyncStatus/SyncStatus.js',
  './src/components/Historial/Historial.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(async (cache) => {
      for (const asset of PRECACHE_ASSETS) {
        try {
          const response = await fetch(asset, { cache: 'reload' });
          if (response && response.ok) {
            await cache.put(asset, response);
          }
        } catch {
          // Ignorar fallo individual en entorno local para no abortar la instalación del SW
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key.startsWith('mineria-pwa-appshell-') && key !== APP_SHELL_CACHE) {
              return caches.delete(key);
            }
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'PRECACHING_VERIFY') {
    event.waitUntil(
      caches.open(APP_SHELL_CACHE).then(async (cache) => {
        for (const asset of PRECACHE_ASSETS) {
          try {
            const existing = await cache.match(asset);
            if (!existing) {
              const res = await fetch(asset);
              if (res && res.ok) await cache.put(asset, res);
            }
          } catch {
            // ignore offline
          }
        }
      })
    );
  }
});

// Estrategia Cache-First con actualización en red para el App Shell y Fallback Offline para navegación (Escenario P5)
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navegación HTML -> devolver index.html del caché si no hay red (Modo Avión)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkRes) => {
          const copy = networkRes.clone();
          caches.open(APP_SHELL_CACHE).then((cache) => cache.put('./index.html', copy));
          return networkRes;
        })
        .catch(async () => {
          const cachedIndex =
            (await caches.match(request)) ||
            (await caches.match('./index.html')) ||
            (await caches.match('./'));
          return cachedIndex || Response.error();
        })
    );
    return;
  }

  // Archivos del App Shell (JS, CSS, PNG, WebManifest) -> Network First con respaldo offline inmediato
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(APP_SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return networkResponse;
      })
      .catch(() => caches.match(request))
  );
});
