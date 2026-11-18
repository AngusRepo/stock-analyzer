import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'
import { logSchedulerResult } from './schedulerRunLogger'

const SECTOR_FLOW_PRE_SCREENER_TIMEOUT_MS = 240_000

/**
 * The screener reads sector_flow(D) as same-session L1 evidence, so the date is
 * closed here, after same-date market_risk and before the screener. A failure
 * leaves the evidence missing (null, never zero); the pipeline tail still
 * closes the date for later readers.
 */
export async function ensureSameSessionSectorFlow(
  env: Bindings,
  asOfDate: string,
  runId: string,
  fetchController: typeof controllerFetch = controllerFetch,
): Promise<string> {
  const startedAt = Date.now()
  try {
    await logSchedulerResult(env.KV, 'sector-flow-pre-screener', {
      status: 'running',
      summary: `sector_flow closure started for ${asOfDate}; run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: asOfDate,
    }, env)
    const res = await fetchController(env, '/sector-flow/daily-closure', {
      method: 'POST',
      jsonBody: { date: asOfDate },
      timeoutMs: SECTOR_FLOW_PRE_SCREENER_TIMEOUT_MS,
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`Controller /sector-flow/daily-closure HTTP ${res.status}: ${text.slice(0, 300)}`)
    let body: any = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (body?.as_of_date !== asOfDate || body?.closure?.status !== 'complete') {
      throw new Error(`sector_flow_closure_unconfirmed:${asOfDate}:${text.slice(0, 200)}`)
    }
    const summary = `sector_flow date=${asOfDate} status=${body.status} rebuild_run_id=${body.rebuild_run_id ?? 'n/a'}`
    await logSchedulerResult(env.KV, 'sector-flow-pre-screener', {
      status: 'success',
      summary,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: asOfDate,
    }, env)
    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await logSchedulerResult(env.KV, 'sector-flow-pre-screener', {
      status: 'error',
      summary: `sector_flow not closed before screener for ${asOfDate}; screener sector evidence stays missing`,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: asOfDate,
      error: message,
    }, env).catch((logError) => console.warn('[Queue] sector-flow-pre-screener log failed:', logError))
    return `sector_flow unavailable before screener: ${message.slice(0, 300)}`
  }
}
