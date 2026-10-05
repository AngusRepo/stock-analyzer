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
}

export async function loadPremarketProgress(db: D1Database, date: string): Promise<PremarketProgressRow[]> {
  const result = await db.prepare(`SELECT business_date,stage,canonical_run_id,status,last_error,queued_at,updated_at,
    COALESCE(json_extract(cursor_key,'$.input.signal_date'),json_extract(cursor_key,'$.signal_date')) AS signal_date,
    COALESCE(json_extract(cursor_key,'$.input.l3_receipt.run_id'),json_extract(cursor_key,'$.l3_receipt.run_id')) AS l3_run_id,
    COALESCE(json_extract(cursor_key,'$.input.l3_receipt.checksum'),json_extract(cursor_key,'$.l3_receipt.checksum')) AS l3_checksum
    FROM pipeline_stage_runs WHERE business_date=? AND canonical_run_id=?
      AND stage='premarket_v3:allocate'`)
    .bind(date,`${date}:premarket-v3`).all<PremarketProgressRow>()
  return result.results ?? []
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
