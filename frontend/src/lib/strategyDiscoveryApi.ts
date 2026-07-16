import { resolveApiBase } from '../const'
import { clearSession, getCsrfToken } from './api'
import type { AnalysisRun, DashboardState, FinalConclusion } from './strategyDiscoveryViewModel'

const BASE = resolveApiBase()

function headers(extra?: Record<string, string>): Headers {
  const value = new Headers(extra)
  return value
}

async function checked(path: string, init?: RequestInit): Promise<Response> {
  const requestHeaders = headers(init?.headers as Record<string, string>)
  const csrfToken = getCsrfToken()
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(String(init?.method ?? 'GET').toUpperCase())) {
    requestHeaders.set('X-CSRF-Token', csrfToken)
  }
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: requestHeaders,
    cache: 'no-store',
    credentials: 'include',
  })
  if (response.status === 401) clearSession()
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string; blockers?: string[] } | null
    const detail = payload?.blockers?.length ? `：${payload.blockers.join('；')}` : ''
    throw new Error(`${payload?.error ?? response.statusText ?? `HTTP ${response.status}`}${detail}`)
  }
  return response
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return checked(path, init).then((response) => response.json() as Promise<T>)
}

export const strategyDiscoveryApi = {
  dashboard: () => json<DashboardState>('/dashboard-state'),
  status: (runId: string) => json<AnalysisRun>(`/runs/${encodeURIComponent(runId)}/status`),
  start: (key: string) => json<{ run_id: string; status: string }>('/full-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ fixture_mode: false }),
  }),
  report: (runId: string) => json<unknown>(`/runs/${encodeURIComponent(runId)}/report`),
  conclusion: (runId: string) => json<FinalConclusion>(`/runs/${encodeURIComponent(runId)}/codex-conclusion`),
  juryBundle: (runId: string) => checked(`/runs/${encodeURIComponent(runId)}/jury-bundle`).then((response) => response.blob()),
  importCodexResult: (runId: string, file: File, key: string) => json<{ run_id: string; status: string }>(
    `/runs/${encodeURIComponent(runId)}/codex-result`,
    { method: 'POST', headers: { 'Content-Type': 'application/zip', 'Idempotency-Key': key }, body: file },
  ),
}
