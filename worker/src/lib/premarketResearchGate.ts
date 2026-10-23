import type { Bindings } from '../types'
import { controllerJson } from './controllerClient'
import { paperExecutionNow } from './paperExecutionScope'

/** All callback, recovery and queue consumers use the same publication clock. */
export async function postPipelineResearchAllowed(env: Partial<Bindings>, day: string, runId: string): Promise<boolean> {
  if (env.PAPER_DAILY_PLAN_OWNER !== 'premarket_once_v1') return true
  const state = await controllerJson<{publication?: {
    signal_date: string; run_id: string; trade_date: string; checksum: string
  } | null}>(env as Bindings, '/pipeline/v2/premarket-state?' + new URLSearchParams({date: day, run_id: runId}))
  if (!state.publication) return false
  const p = state.publication
  const close = Date.parse(p.trade_date + 'T13:30:00+08:00')
  if (p.signal_date !== day || p.run_id !== runId || !/^[a-f0-9]{64}$/.test(p.checksum)
      || !/^\d{4}-\d{2}-\d{2}$/.test(p.trade_date) || !Number.isFinite(close))
    throw new Error('post_pipeline_serving_identity_invalid')
  return paperExecutionNow() >= close
}
