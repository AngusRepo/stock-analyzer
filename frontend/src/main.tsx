import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { defaultQueryOptions } from './lib/queryPolicy'
import './index.css'

let serviceWorkerReloadScheduled = false
let assetRecoveryScheduled = false

function recoverStaleAssetGraph() {
  if (assetRecoveryScheduled) return
  assetRecoveryScheduled = true
  void navigator.serviceWorker?.getRegistration()
    .then((registration) => registration?.update())
    .finally(() => window.location.reload())
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (serviceWorkerReloadScheduled) return
    serviceWorkerReloadScheduled = true
    window.location.reload()
  })
}

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  recoverStaleAssetGraph()
})

window.addEventListener('unhandledrejection', (event) => {
  const detail = String(event.reason?.message ?? event.reason ?? '')
  if (!/Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(detail)) return
  event.preventDefault()
  recoverStaleAssetGraph()
})

const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    void updateServiceWorker(false)
  },
  onRegisteredSW(_swUrl, registration) {
    void registration?.update()
  },
})

const queryClient = new QueryClient({
  defaultOptions: defaultQueryOptions,
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
