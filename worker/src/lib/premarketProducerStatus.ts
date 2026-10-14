/** A concurrent producer lease is pending; its durable row owns the outcome. */
export async function runPremarketProducerTask(stage: string, execute: () => Promise<string>): Promise<string> {
  try {
    return await execute()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const running = /^premarket_wait:([^:]+):running:attempt=([1-3]):next=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/.exec(message)
    if (!running || running[1] !== stage) throw error
    return `status=pending ${message}`
  }
}

export interface PremarketProducerRow {
  business_date: string
  stage: string
  canonical_run_id: string
  status: string
  persisted_count: number
  attempt_count: number
  lease_expires_at: string | null
  last_error: string | null
  updated_at: string
}

export async function loadPremarketProducerStates(db: D1Database, date: string): Promise<PremarketProducerRow[]> {
  const { results } = await db.prepare(`SELECT business_date,stage,canonical_run_id,status,persisted_count,
    attempt_count,lease_expires_at,last_error,updated_at FROM pipeline_stage_runs
    WHERE business_date=? AND stage IN ('premarket_v2:news-analyst','premarket_v2:us-leading')
      AND canonical_run_id=business_date || ':' || stage`).bind(date).all<PremarketProducerRow>()
  return results ?? []
}

export function premarketProducerDisplay(jobId: string, date: string, rows: PremarketProducerRow[], now = Date.now()) {
  if (!['news-analyst', 'us-leading'].includes(jobId)) return null
  const stage = `premarket_v2:${jobId}`
  const row = rows.find(r => r.business_date === date && r.stage === stage
    && r.canonical_run_id === `${date}:${stage}`)
  if (!row) return null
  const utc = (value: string) => value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
  if (row.status === 'success' && row.persisted_count !== 1) return null
  if (['running', 'waiting'].includes(row.status)
    && (!row.lease_expires_at || !(Date.parse(utc(row.lease_expires_at)) > now))) return null
  if (!['success', 'running', 'waiting', 'error'].includes(row.status)) return null
  return {
    lastStatus: row.status,
    lastError: row.status === 'error' ? row.last_error ?? undefined : undefined,
    lastRunAt: utc(row.updated_at),
    summary: `status=${row.status} producer_stage=${stage} attempt=${row.attempt_count}`,
    statusScope: 'durable_event' as const,
    statusRunDate: date,
    statusAuthority: 'durable_pipeline_stage' as const,
    runId: row.canonical_run_id,
    attemptCount: row.attempt_count,
  }
}
