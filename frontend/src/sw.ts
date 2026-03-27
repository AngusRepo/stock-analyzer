/**
 * StockVision Service Worker (Workbox + injectManifest)
 *
 * 策略：
 *   - App shell (HTML/JS/CSS) → precache（vite-plugin-pwa 自動注入 manifest）
 *   - API (/api/*)            → NetworkOnly（不 cache 財務資料）
 *   - 圖片 / 靜態資源         → CacheFirst（stale-while-revalidate）
 *   - Navigation fallback     → 離線時回傳 index.html
 */

import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { NetworkOnly, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { createHandlerBoundToURL } from 'workbox-precaching'

/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: any[] }

// Auto-injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST)

// Clean old caches on upgrade
cleanupOutdatedCaches()

// API calls — always go to network
registerRoute(
  ({ url }) => url.pathname.startsWith('/api'),
  new NetworkOnly(),
)

// Images / fonts — cache first (30 days)
registerRoute(
  ({ request }) => request.destination === 'image' || request.destination === 'font',
  new CacheFirst({
    cacheName: 'assets-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 })],
  }),
)

// JS/CSS — stale-while-revalidate
registerRoute(
  ({ request }) => request.destination === 'script' || request.destination === 'style',
  new StaleWhileRevalidate({ cacheName: 'code-cache' }),
)

// SPA Navigation fallback — offline → serve cached /index.html
const handler = createHandlerBoundToURL('/index.html')
const navRoute = new NavigationRoute(handler, { denylist: [/^\/api\//] })
registerRoute(navRoute)
