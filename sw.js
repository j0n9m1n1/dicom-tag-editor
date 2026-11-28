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
  './src/dicom/calendar.js',
  './src/dicom/charset.js',
  './src/dicom/dcmdump.js',
  './src/dicom/dictionary.js',
  './src/dicom/encapsulation.js',
  './src/dicom/jpegLossless.js',
  './src/dicom/standardDict.js',
  './src/dicom/parser.js',
  './src/dicom/phiSpec.js',
  './src/dicom/pixelGeometry.js',
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

const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            cache.add(new Request(url, { cache: 'no-cache' }))
          )
        )
      )
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
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

function fetchWithTimeout(request, init, timeoutMs = NETWORK_TIMEOUT_MS) {
  if (typeof AbortController === 'undefined') {
    return fetch(request, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const networkReq = request.mode === 'navigate'
    ? fetchWithTimeout(request.url, { cache: 'no-cache' })
    : fetchWithTimeout(request, { cache: 'no-cache' });

  event.waitUntil(networkReq.then((response) => {
    if (!response.ok || response.type !== 'basic') return;
    const copy = response.clone();
    return caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }).catch(() => {}));

  event.respondWith(
    networkReq.catch(async () => {
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
