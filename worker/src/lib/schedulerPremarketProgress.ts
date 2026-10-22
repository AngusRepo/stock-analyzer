/** Read-only display of the current trading day's durable premarket handoff. */
export interface PremarketProgressRow {
  business_date: string
  stage: string
  canonical_run_id: string
  status: string
  last_error: string | null
  queued_at: string | null
  updated_at: string
  signal_date: string | null
  l3_run_id: string | null
  l3_checksum: string | null
  publication_ready?: number | null
  pending_status?: string | null
}

export async function loadPremarketProgress(db: D1Database, date: string): Promise<PremarketProgressRow[]> {
  const result = await db.prepare(`SELECT business_date,stage,canonical_run_id,status,last_error,queued_at,updated_at,
    COALESCE(json_extract(cursor_key,'$.input.signal_date'),json_extract(cursor_key,'$.signal_date')) AS signal_date,
    COALESCE(json_extract(cursor_key,'$.input.l3_receipt.run_id'),json_extract(cursor_key,'$.l3_receipt.run_id')) AS l3_run_id,
    COALESCE(json_extract(cursor_key,'$.input.l3_receipt.checksum'),json_extract(cursor_key,'$.l3_receipt.checksum')) AS l3_checksum,
    json_extract(cursor_key,'$.output.ready') AS publication_ready,
    json_extract(cursor_key,'$.output.pending_status') AS pending_status
    FROM pipeline_stage_runs WHERE business_date=? AND canonical_run_id=?
      AND stage IN ('premarket_v3:allocate','premarket_v3:publish:0','premarket_v3:market-health')`)
    .bind(date,`${date}:premarket-v3`).all<PremarketProgressRow>()
  return result.results ?? []
}

/** Terminal business receipts outrank unclosed dispatch acknowledgements. */
export function premarketReadinessDisplay(jobId: string, date: string, rows: PremarketProgressRow[], dispatchUpdatedAt?: string) {
  if (jobId !== 'pre-market-warmup') return null
  const exact = rows.filter(row => row.business_date === date && row.canonical_run_id === `${date}:premarket-v3`)
  const published = exact.find(row => row.stage === 'premarket_v3:publish:0' && row.status === 'success'
    && row.publication_ready === 1 && ['ready','empty','halted'].includes(row.pending_status ?? '')
    && row.signal_date && row.l3_run_id && /^[a-f0-9]{64}$/.test(row.l3_checksum ?? ''))
  const health = exact.find(row => row.stage === 'premarket_v3:market-health')
  const allocate = exact.find(row => row.stage === 'premarket_v3:allocate')
  if (!published || health?.status !== 'success' || allocate?.status !== 'success'
    || allocate.l3_run_id !== published.l3_run_id || allocate.l3_checksum !== published.l3_checksum
    || allocate.signal_date !== published.signal_date) return null
  const utc = (value: string) => value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
  const times = [allocate.updated_at, published.updated_at, health.updated_at].map(value => Date.parse(utc(value)))
  if (!times.every(Number.isFinite) || times[0] > times[1]) return null
  const completedMs = Math.max(times[1], times[2])
  if (dispatchUpdatedAt && Date.parse(utc(dispatchUpdatedAt)) > completedMs) return null
  const completedAt = new Date(completedMs).toISOString()
  return {
    lastStatus: 'success' as const, lastRunAt: completedAt, lastError: undefined,
    summary: `盤前發布與健康檢查已完成；pending=${published.pending_status}`,
    lastDuration: 'N/A', nextRun: '下一交易日盤前', statusScope: 'today' as const,
    statusRunDate: date, statusAuthority: 'durable_pipeline_stage' as const,
    runId: `${date}:premarket-v3`, recoveredFromStatus: null,
  }
}

export function premarketExecutionDisplay(input: {
  jobId: string; today: string; businessDate: string | null; rows: PremarketProgressRow[];
  ticketStatus?: string;
  pipeline?: { business_date: string; canonical_run_id: string; status: string; last_error: string | null };
}) {
  if (!['pipeline','recommendation'].includes(input.jobId)) return null
  if (['error','blocked','skipped','success'].includes(input.ticketStatus ?? '')) return null
  const pipeline = input.pipeline
  if (!pipeline || pipeline.business_date !== input.businessDate || pipeline.status !== 'waiting'
    || pipeline.last_error !== 'awaiting_premarket') return null
  const row = input.rows.find(r => r.business_date === input.today
    && r.canonical_run_id === `${input.today}:premarket-v3` && r.stage === 'premarket_v3:allocate'
    && r.signal_date === pipeline.business_date && r.l3_run_id === pipeline.canonical_run_id
    && /^[a-f0-9]{64}$/.test(r.l3_checksum ?? ''))
  if (!row) return null
  const dispatched = row.status === 'waiting' && row.last_error === 'Error: premarket_wait:l4_completion'
  if (!dispatched && row.status !== 'running') return null
  const timestamp = row.queued_at ?? row.updated_at
  return {
    lastStatus: 'running' as const,
    pipelinePhase: 'premarket_l4' as const,
    summary: dispatched ? '盤前 L4 已派送，等待計算與正式發布完成' : '盤前鏈正在接續 L4 推薦',
    lastError: undefined,
    lastRunAt: timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + 'Z',
    lastDuration: 'N/A', nextRun: '等待 L4 完成回呼',
    statusScope: 'durable_event' as const, statusAuthority: 'durable_pipeline_stage' as const,
    recoveredFromStatus: null,
  }
}

export function premarketWatchdogDisplay(jobId: string, log?: { status: string; summary?: string }, ticketStatus?: string) {
  if (['error','blocked','skipped','success'].includes(ticketStatus ?? '')) return null
  if (jobId !== 'premarket-evidence-watchdog' || log?.status !== 'triggered'
    || !/^status=pending premarket_event_chain\b/.test(log.summary ?? '')) return null
  return {
    lastStatus: 'waiting' as const,
    summary: `本次盤前鏈檢查已完成，等待下游階段；${log.summary}`,
    lastError: undefined,
  }
}
