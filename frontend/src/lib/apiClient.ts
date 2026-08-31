import { resolveApiBase } from '../const'

export const apiBase = resolveApiBase()
export const AUTH_TOKEN_EVENT = 'stockvision:auth-token'

let token: string | null = sessionStorage.getItem('sv_token')

function formatApiError(path: string, status: number, statusText: string, payload: any): string {
  const serverMessage = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : typeof payload?.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : ''
  const rawBase = serverMessage || statusText || `HTTP ${status}`
  const isOpaqueProxy500 = status === 500 && rawBase === 'Internal Server Error'
  const base = isOpaqueProxy500 ? 'API unavailable' : rawBase
  const localHint = isOpaqueProxy500 ? ' Local dev hint: check that the Worker API is running on localhost:8787.' : ''
  return `${base} (${path}, HTTP ${status}).${localHint}`
}

function emitAuthTokenEvent(authenticated: boolean) {
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_EVENT, { detail: { authenticated } }))
}

export function setToken(value: string) {
  token = value
  sessionStorage.setItem('sv_token', value)
  emitAuthTokenEvent(true)
}

export function clearToken() {
  token = null
  sessionStorage.removeItem('sv_token')
  emitAuthTokenEvent(false)
}

export function getToken() {
  return token
}

export type ApiRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  requestOptions: ApiRequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  Object.assign(headers, extraHeaders)

  const timeoutMs = Number(requestOptions.timeoutMs)
  const timeoutEnabled = Number.isFinite(timeoutMs) && timeoutMs > 0
  const controller = timeoutEnabled ? new AbortController() : null
  let timeoutTriggered = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const abortFromCaller = () => controller?.abort(requestOptions.signal?.reason)

  if (controller && requestOptions.signal) {
    if (requestOptions.signal.aborted) abortFromCaller()
    else requestOptions.signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  if (controller) {
    timeoutId = setTimeout(() => {
      timeoutTriggered = true
      controller.abort(new DOMException('Request timed out', 'TimeoutError'))
    }, timeoutMs)
  }

  try {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: method === 'GET' ? 'no-store' : undefined,
      signal: controller?.signal ?? requestOptions.signal,
    })
    if (response.status === 401) {
      clearToken()
      throw new Error('Unauthorized')
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as any
      throw new Error(formatApiError(path, response.status, response.statusText, payload))
    }
    return response.json()
  } catch (error) {
    if (timeoutTriggered) throw new Error(`Request timeout after ${timeoutMs}ms (${path}).`)
    throw error
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    requestOptions.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export const apiGet = <T>(path: string, options?: ApiRequestOptions) => apiRequest<T>('GET', path, undefined, undefined, options)
export const apiPost = <T>(path: string, body?: unknown) => apiRequest<T>('POST', path, body)
export const apiPut = <T>(path: string, body?: unknown) => apiRequest<T>('PUT', path, body)
export const apiDelete = <T>(path: string) => apiRequest<T>('DELETE', path)
