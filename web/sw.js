/* 墨读 InkRead — Service Worker (PWA 离线缓存)
 * 策略：network-first（改动即时生效），离线时回退缓存——兼顾开发与离线阅读
 * 改动前端资源后，请递增 CACHE_VERSION 以触发缓存刷新。
 */
const CACHE_VERSION = 'inkread-v4';
const CACHE_NAME = 'inkread-shell-' + CACHE_VERSION;

// 预缓存清单：全部为相对于 sw.js 的路径（sw.js 位于站点根目录）
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/util.js',
  './js/storage.js',
  './js/dict.js',
  './js/themes.js',
  './js/importers.js',
  './js/translate.js',
  './js/vocab.js',
  './js/phrases.js',
  './js/reader.js',
  './js/settings.js',
  './js/app.js',
  './lib/jszip.min.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js',
  './lib/xlsx.full.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 不进缓存的路径片段（动态大文件 / 外部资源）
const NO_CACHE_PATTERNS = ['/dict/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of PRECACHE_URLS) {
      try {
        await cache.add(url);
      } catch (e) {
        console.warn('[sw] 预缓存失败（已忽略）：', url, e && e.message);
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function shouldSkipCache(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (NO_CACHE_PATTERNS.some((p) => url.pathname.includes(p))) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨域（外部 API / 词典站）：直接走网络，不缓存
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 504 })));
    return;
  }

  // 动态大文件（词典分片）：network-only
  if (shouldSkipCache(url)) {
    event.respondWith(fetch(req));
    return;
  }

  // 同源全部 network-first：在线时永远用最新，离线回退缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
