import type { Bindings } from '../types'

type ControllerMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface ControllerRequestOptions {
  method?: ControllerMethod
  jsonBody?: unknown
  timeoutMs?: number
  headers?: Record<string, string>
}

function getControllerBaseUrl(env: Bindings): string {
  const baseUrl = env.ML_CONTROLLER_URL?.trim()
  if (!baseUrl) throw new Error('ML_CONTROLLER_URL not set')
  return baseUrl
}

export function buildControllerHeaders(
  env: Bindings,
  headers: Record<string, string> = {},
  includeJsonContentType = false,
): Record<string, string> {
  const merged: Record<string, string> = { ...headers }
  if (includeJsonContentType && !merged['Content-Type']) {
    merged['Content-Type'] = 'application/json'
  }
  if (env.ML_CONTROLLER_SECRET && !merged['X-Controller-Token']) {
    merged['X-Controller-Token'] = env.ML_CONTROLLER_SECRET
  }
  return merged
}

export async function controllerFetch(
  env: Bindings,
  path: string,
  options: ControllerRequestOptions = {},
): Promise<Response> {
  const {
    method = 'GET',
    jsonBody,
    timeoutMs = 60_000,
    headers = {},
  } = options

  return fetch(`${getControllerBaseUrl(env)}${path}`, {
    method,
    headers: buildControllerHeaders(env, headers, jsonBody !== undefined),
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  })
}

export async function controllerJson<T>(
  env: Bindings,
  path: string,
  options: ControllerRequestOptions = {},
): Promise<T> {
  const res = await controllerFetch(env, path, options)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Controller ${path} HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

export function controllerPostJson<T>(
  env: Bindings,
  path: string,
  jsonBody: unknown,
  timeoutMs = 300_000,
): Promise<T> {
  return controllerJson<T>(env, path, { method: 'POST', jsonBody, timeoutMs })
}
