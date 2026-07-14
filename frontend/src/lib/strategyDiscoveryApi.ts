import { resolveApiBase } from '../const'
import { clearToken, getToken } from './api'
import type { AnalysisRun, DashboardState, FinalConclusion } from './strategyDiscoveryViewModel'

const BASE = resolveApiBase()

function headers(extra?: Record<string, string>): Headers {
  const value = new Headers(extra)
  const token = getToken()
  if (token) value.set('Authorization', `Bearer ${token}`)
  return value
}

async function checked(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: headers(init?.headers as Record<string, string>), cache: 'no-store' })
  if (response.status === 401) clearToken()
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
