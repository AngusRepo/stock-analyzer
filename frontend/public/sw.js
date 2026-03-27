// StockVision Service Worker — 自毀模式
// Cloudflare Pages CDN 已處理 cache，不再需要自定義 SW
// 這個 SW 的唯一目的是卸載自己並清除舊 cache

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
    .then(() => self.registration.unregister())
  )
})
