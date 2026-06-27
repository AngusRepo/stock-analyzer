import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'
import { twToday } from './dateUtils'

function resolveScreenerJobDate(runDate?: string | null): string {
  const value = (runDate || '').trim()
  if (!value) return twToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid screener run date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}

export interface ScreenerJobTriggerOptions {
  chainRunId?: string
}

export async function runScreenerV2(
  env: Bindings,
  runDate?: string | null,
  options: ScreenerJobTriggerOptions = {},
): Promise<string> {
  const twDate = resolveScreenerJobDate(runDate)
  const params = new URLSearchParams({ date: twDate })
  if (options.chainRunId) params.set('chain_run_id', options.chainRunId)

  const res = await controllerFetch(env, `/screener/v2/run?${params.toString()}`, {
    method: 'POST',
    jsonBody: {
      run_date: twDate,
      chain_run_id: options.chainRunId || undefined,
    },
    timeoutMs: 30_000,
  })

  const text = await res.text().catch(() => '')
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (res.status === 409) {
    const detail = body?.detail ?? body ?? text
    const executionId = typeof detail?.execution_id === 'string' ? detail.execution_id : 'unknown'
    throw new Error(`Screener V2 already has an active execution=${executionId}; date=${twDate}; refusing to wait on an unrelated callback`)
  }
  if (res.status !== 202 && !res.ok) {
    throw new Error(`Screener V2 trigger HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  const runId = String(body?.run_id ?? 'unknown')
  const executionId = String(body?.execution_id ?? 'unknown')
  return [
    `triggered run_id=${runId}`,
    `execution=${executionId}`,
    `date=${twDate}`,
    options.chainRunId ? `chain_run_id=${options.chainRunId}` : null,
    'callback expected',
  ].filter(Boolean).join(' ')
}
