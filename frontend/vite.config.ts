import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { execSync } from 'node:child_process'
import { VitePWA } from 'vite-plugin-pwa'

function resolveBuildId() {
  const envBuildId = process.env.CF_PAGES_COMMIT_SHA || process.env.VITE_BUILD_ID
  if (envBuildId) return envBuildId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16)
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim().replace(/[^a-zA-Z0-9_-]/g, '')
  } catch {
    return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 12)
  }
}

const BUILD_ID = resolveBuildId()
const BUILD_STAMP = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
    'import.meta.env.VITE_BUILD_STAMP': JSON.stringify(BUILD_STAMP),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: true },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // 2026-04-21 fix: without these flags new sw waits for all tabs to
        // close before activating → user sees stale bundle after deploy.
        // skipWaiting + clientsClaim makes new sw take over on next refresh.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // API calls: never cache financial data
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images-cache',
              expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
      },
      manifest: {
        name: 'StockVision 股票分析平台',
        short_name: 'StockVision',
        description: '台股＋美股 AI 驅動分析平台',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0b0f',
        theme_color: '#0a0b0f',
        lang: 'zh-TW',
        categories: ['finance', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        shortcuts: [
          {
            name: 'Bot Dashboard',
            short_name: 'Bot',
            url: '/bot',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${BUILD_ID}-[hash].js`,
        chunkFileNames: `assets/[name]-${BUILD_ID}-[hash].js`,
        assetFileNames: `assets/[name]-${BUILD_ID}-[hash][extname]`,
        manualChunks: {
          'vendor-react':  ['react', 'react-dom', 'react-router-dom'],
          'vendor-query':  ['@tanstack/react-query'],
          'vendor-charts': ['recharts', 'lightweight-charts'],
          'vendor-ui':     ['@radix-ui/react-tabs', '@radix-ui/react-dialog',
                            '@radix-ui/react-dropdown-menu', '@radix-ui/react-tooltip'],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
