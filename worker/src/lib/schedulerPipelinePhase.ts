/** Display-only projection of the authenticated L3 handoff. Never closes the DAG. */
type PipelineRow = { business_date: string; canonical_run_id: string; status: string; last_error: string | null }
type PipelineLog = { run_date?: string; run_id?: string; status: string; summary?: string }
export function sealedPremarketDisplay(input: {
  jobId: string; businessDate: string | null; stage?: PipelineRow; log?: PipelineLog;
  ticketStatus?: string;
}): { lastStatus: 'waiting' | 'success'; summary: string; lastError: undefined;
  statusAuthority: 'durable_pipeline_stage'; recoveredFromStatus: null;
  lastRun?: string; lastRunAt?: null; lastDuration?: string; nextRun?: string } | null {
  const { jobId, businessDate, stage, log, ticketStatus } = input
  if (!['evening-chain', 'pipeline', 'ml-predict', 'recommendation'].includes(jobId)) return null
  if (!businessDate || stage?.business_date !== businessDate || stage.status !== 'waiting'
    || stage.last_error !== 'awaiting_premarket' || !stage.canonical_run_id
    || log?.run_id !== stage.canonical_run_id || log.run_date !== businessDate
    || log.status !== 'triggered'
    || !/\bl3_sealed=true\b/.test(log.summary ?? '')
    || !/\bcloud_compute_stopped=true\b/.test(log.summary ?? '')
    || ['error', 'blocked', 'skipped', 'success'].includes(ticketStatus ?? '')) return null
  const lastStatus = jobId === 'ml-predict' ? 'success' : 'waiting'
  const summary = jobId === 'ml-predict'
    ? 'L3 預測已完成並封存；未重新執行模型'
    : jobId === 'recommendation'
      ? '等待下一交易日盤前資訊，再執行一次 L4 推薦'
      : 'L3 已封存，等待下一交易日盤前接續；Cloud Run 已停止運算'
  return { lastStatus, summary, lastError: undefined,
    statusAuthority: 'durable_pipeline_stage', recoveredFromStatus: null,
    ...(['ml-predict', 'recommendation'].includes(jobId) ? { lastDuration: 'N/A' } : {}),
    ...(jobId === 'recommendation' ? { lastRun: 'N/A', lastRunAt: null, nextRun: '等待盤前資訊' } : {}),
  }
}
