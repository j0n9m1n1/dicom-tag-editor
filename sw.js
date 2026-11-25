/**
 * Offline Service Worker for DICOM Tag Editor PWA.
 * Strategy: Network-First with Cache Fallback for same-origin app assets.
 * CACHE_VERSION and versioned ./src/* URLs are automatically updated during CI deploy.
 */

const CACHE_VERSION = 'dev';
const CACHE_PREFIX = 'dcm-editor-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './src/styles.css',
  './src/main.js',
  './src/i18n.js',
  './src/state/store.js',
  './src/io/fileIo.js',
  './src/utils/uiHelpers.js',
  './src/utils/zipWriter.js',
  './src/dicom/charset.js',
  './src/dicom/dcmdump.js',
  './src/dicom/dictionary.js',
  './src/dicom/standardDict.js',
  './src/dicom/parser.js',
  './src/dicom/phiSpec.js',
  './src/dicom/pixelRenderer.js',
  './src/dicom/qaChecker.js',
  './src/dicom/sampleGenerator.js',
  './src/dicom/srParser.js',
  './src/dicom/uid.js',
  './src/dicom/vrSpec.js',
  './src/dicom/writer.js',
  './src/ui/fileList.js',
  './src/ui/fileTabs.js',
  './src/ui/compareView.js',
  './src/ui/rawView.js',
  './src/ui/srView.js',
  './src/ui/icons.js',
  './src/ui/inspector.js',
  './src/ui/modals.js',
  './src/ui/pixelPanel.js',
  './src/ui/popupMenu.js',
  './src/ui/treeView.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const exact = await caches.match(request);
        if (exact) return exact;
        const loose = await caches.match(request, { ignoreSearch: true });
        if (loose) return loose;
        if (request.mode === 'navigate') {
          const shell = (await caches.match('./index.html')) || (await caches.match('./'));
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })
  );
});
