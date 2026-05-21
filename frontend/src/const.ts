export const COOKIE_NAME = 'sv_session'
export const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000
export const DEFAULT_WORKER_API_URL = 'https://stockvision-worker.angus-solo-dev.workers.dev/api'

export function resolveApiBase() {
  const configured = import.meta.env.VITE_API_URL
  if (configured) return configured
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    if (host === 'stockvision-frontend.pages.dev' || host.endsWith('.stockvision-frontend.pages.dev')) {
      return DEFAULT_WORKER_API_URL
    }
  }
  return '/api'
}

export const getLoginUrl = () => `${resolveApiBase()}/auth/google`
