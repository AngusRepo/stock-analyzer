import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { defaultQueryOptions } from './lib/queryPolicy'
import './index.css'

const serviceWorkerReloadKey = `stockvision:sw-reload:${import.meta.env.VITE_BUILD_ID}`
let serviceWorkerReloadScheduled = false

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (serviceWorkerReloadScheduled || sessionStorage.getItem(serviceWorkerReloadKey) === '1') return
    serviceWorkerReloadScheduled = true
    sessionStorage.setItem(serviceWorkerReloadKey, '1')
    window.location.reload()
  })
}

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
