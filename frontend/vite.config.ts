import { execSync } from 'node:child_process'
import path from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
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

const MANUAL_CHUNK_GROUPS: Record<string, string[]> = {
  'vendor-react': ['react', 'react-dom', 'react-router-dom'],
  'vendor-query': ['@tanstack/react-query'],
  'vendor-charts': ['recharts', 'lightweight-charts'],
  'vendor-ui': [
    '@radix-ui/react-tabs',
    '@radix-ui/react-dialog',
    '@radix-ui/react-dropdown-menu',
    '@radix-ui/react-tooltip',
  ],
}

function resolveManualChunk(id: string) {
  const normalized = id.replace(/\\/g, '/')
  if (!normalized.includes('/node_modules/')) return undefined

  for (const [chunkName, packages] of Object.entries(MANUAL_CHUNK_GROUPS)) {
    if (packages.some((packageName) => normalized.includes(`/node_modules/${packageName}/`))) {
      return chunkName
    }
  }

  return undefined
}

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
      devOptions: { enabled: process.env.VITE_PWA_DEV === '1' },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
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
        id: '/',
        name: 'StockVision 股票分析平台',
        short_name: 'StockVision',
        description: '台股量化、AI 推薦與風險監控平台',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone', 'browser'],
        orientation: 'portrait-primary',
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
            name: '晨間概覽',
            short_name: 'Dashboard',
            description: '開啟 StockVision 首頁市場概覽',
            url: '/',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
          },
          {
            name: '模型池',
            short_name: 'Models',
            description: '查看模型池與升級狀態',
            url: '/model-pool',
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
        manualChunks: resolveManualChunk,
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
