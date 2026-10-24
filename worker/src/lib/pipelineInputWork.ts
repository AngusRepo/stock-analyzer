import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'

export type PipelineInputWork = {
  run_id: string; run_date: string; phase: string; stage_id: string
  status: 'running' | 'waiting' | 'failed' | 'unknown'
  active: number; completed: number; total: number; observed_at: string
  execution_id?: string; started_at?: string | null
}

export function matchesInputWork(value: unknown, run: string, date: string, phase: string, now = Date.now()): value is PipelineInputWork {
  const p = value as PipelineInputWork
  return Boolean(p && p.run_id === run && p.run_date === date && p.phase === phase
    && ['running','waiting','failed','unknown'].includes(p.status)
    && typeof p.stage_id === 'string' && (/^[a-f0-9]{64}$/.test(p.stage_id) || (p.status === 'unknown' && !p.stage_id))
    && [p.active,p.completed,p.total].every(n => Number.isSafeInteger(n) && n >= 0)
    && p.active + p.completed <= p.total && p.total <= 128
    && (p.status !== 'running' || p.active > 0)
    && typeof p.observed_at === 'string' && Number.isFinite(Date.parse(p.observed_at))
    && now - Date.parse(p.observed_at) >= -5_000 && now - Date.parse(p.observed_at) <= 30_000)
}

export async function loadPipelineInputWork(env: Bindings, run: string, date: string, phase: string): Promise<PipelineInputWork | undefined> {
  if (!['input_snapshot','input_prep','prepare_prediction_request'].includes(phase)) return undefined
  const key = `scheduler:input-work:v1:${date}:${run}:${phase}`
  try {
    const cached = await env.KV.get(key, 'json')
    if (matchesInputWork(cached, run, date, phase)) return cached
    const params = new URLSearchParams({date, run_id: run, phase})
    const response = await controllerFetch(env, `/pipeline/v2/input/status?${params}`, {timeoutMs: 5_000})
    if (!response.ok) return undefined
    const value: unknown = await response.json()
    if (!matchesInputWork(value, run, date, phase)) return undefined
    await env.KV.put(key, JSON.stringify(value), {expirationTtl: 60}).catch(() => undefined)
    return value
  } catch { return undefined }
}
