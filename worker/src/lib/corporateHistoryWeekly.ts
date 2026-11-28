import type { Bindings } from '../types'
import { controllerFetch } from './controllerClient'
import { opsCorrelationHeaders } from './opsRuntimeScope'
import { twToday } from './dateUtils'

export const CORPORATE_HISTORY_WEEKLY_TASK = 'corporate-history-weekly'
// Mirrors the controller request model (run_id 44–72 chars, 8–32 lowercase hex suffix).
export const CORPORATE_HISTORY_WEEKLY_RUN_ID_PATTERN = /^corporate-history-weekly-\d{4}-\d{2}-\d{2}-[a-f0-9]{8,32}$/

export function buildCorporateHistoryWeeklyRunId(
  runDate: string,
  entropy = crypto.randomUUID().replaceAll('-', '').slice(0, 16),
): string {
  const runId = `${CORPORATE_HISTORY_WEEKLY_TASK}-${runDate}-${entropy.toLowerCase()}`
  if (!CORPORATE_HISTORY_WEEKLY_RUN_ID_PATTERN.test(runId)) {
    throw new Error('invalid corporate-history-weekly run_id components')
  }
  return runId
}

function detailError(text: string): string {
  try {
    const detail = (JSON.parse(text) as { detail?: unknown })?.detail
    if (detail && typeof detail === 'object' && typeof (detail as { error?: unknown }).error === 'string') {
      return (detail as { error: string }).error
    }
  } catch {
    // Non-JSON bodies (Cloud Run 5xx HTML) fall through to the raw prefix.
  }
  return text.slice(0, 200)
}

/**
 * Saturday research corporate-history export: hand one Cloud Run execution to the controller.
 * The ticket stays `triggered`; the Job's scheduler-callback closes the run log (same as weekly-backtest).
 */
export async function runCorporateHistoryWeeklyExport(env: Bindings, runDate?: string): Promise<string> {
  if (!env.ML_CONTROLLER_URL) throw new Error('ML_CONTROLLER_URL not set')
  if (runDate && !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    return 'failed: corporate-history-weekly requires YYYY-MM-DD run_date'
  }
  const resolvedRunDate = runDate ?? twToday()
  const runId = buildCorporateHistoryWeeklyRunId(resolvedRunDate)

  let resp: Response
  try {
    resp = await controllerFetch(env, '/datasets/corporate-history/weekly', {
      method: 'POST',
      headers: opsCorrelationHeaders(),
      jsonBody: { run_date: resolvedRunDate, run_id: runId, dry_run: false },
      timeoutMs: 60_000,
    })
  } catch (error) {
    return `failed: corporate-history-weekly controller dispatch error run_id=${runId}: ${error instanceof Error ? error.message : String(error)}`
  }

  const text = await resp.text().catch(() => '')
  if (resp.status === 409) {
    return `failed: corporate-history-weekly execution already running run_id=${runId} reason=${detailError(text)}`
  }
  if (resp.status === 422) {
    return `failed: corporate-history-weekly run identity rejected HTTP 422 run_id=${runId} reason=${detailError(text)}`
  }
  if (!resp.ok) {
    return `failed: corporate-history-weekly controller dispatch HTTP ${resp.status} run_id=${runId} reason=${detailError(text)}`
  }

  let result: Record<string, unknown> = {}
  try {
    result = text ? JSON.parse(text) as Record<string, unknown> : {}
  } catch {
    return `failed: corporate-history-weekly controller returned non-json run_id=${runId}`
  }
  const executionId = String(result.execution_id ?? '')
  if (result.status !== 'dispatched' || result.run_id !== runId
    || String(result.run_date ?? '') !== resolvedRunDate || !executionId) {
    return `failed: corporate-history-weekly dispatch not confirmed status=${String(result.status ?? 'missing')} `
      + `expected_run_id=${runId} returned_run_id=${String(result.run_id ?? 'missing')} execution_id=${executionId || 'missing'}`
  }
  return `triggered corporate-history-weekly run_id=${runId} execution_id=${executionId} callback expected`
}
