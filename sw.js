/* 智慧学习平台 Service Worker
 * 策略：网络优先 + 缓存兜底（始终拿最新版，离线时用缓存）
 * 注意：仅拦截本站 GET；Supabase 云端 API 请求（跨域）不拦截，保证数据同步正常。
 */
const CACHE = 'xuexipingtai-v1';
const CORE = [
  './',
  './index.html',
  './admin.html',
  './learning.html',
  './sync.js?v=20260825b',
  './email.min.js',
  './chart.umd.min.js',
  './textbook.js',
  './student-enhance.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  // 跨域（Supabase API / 外部资源）不缓存处理
  if (url.origin !== self.location.origin) return;
  // 网络优先，失败回退缓存
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((m) => m || caches.match('./index.html'))
      )
  );
});
