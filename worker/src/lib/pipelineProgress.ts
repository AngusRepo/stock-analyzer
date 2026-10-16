/** Observability only: no dispatch lease, continuation, or terminal mutation. */
export type PipelinePhaseReceipt = { phase: string; elapsed_ms: number; status: 'completed' | 'failed' | 'blocked' | 'waiting'; started_at?: string | null; completed_at?: string }
export type PipelineProgress = {
  phase: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'blocked'
  started_at: string; phase_started_at: string; observed_at: string; execution_id: string
  completed: PipelinePhaseReceipt[]
  executions?: Record<string, PipelinePhaseReceipt[]>
  phase_rank?: number
}

export function validPipelineProgress(value: unknown): value is PipelineProgress {
  const p = value as PipelineProgress
  const phase = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(v)
  const stamp = (v: unknown) => typeof v === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
  return Boolean(p && phase(p.phase) && ['running','waiting','completed','failed','blocked'].includes(p.status)
    && stamp(p.started_at) && stamp(p.phase_started_at) && stamp(p.observed_at)
    && Date.parse(p.started_at) <= Date.parse(p.phase_started_at) && Date.parse(p.phase_started_at) <= Date.parse(p.observed_at)
    && typeof p.execution_id === 'string' && p.execution_id.length <= 200
    && Array.isArray(p.completed) && p.completed.length <= 32 && p.completed.every(row => row && phase(row.phase)
      && Number.isSafeInteger(row.elapsed_ms) && row.elapsed_ms >= 0 && ['completed','failed','blocked','waiting'].includes(row.status)
      && (row.started_at == null || (stamp(row.started_at) && stamp(row.completed_at)
        && Date.parse(row.started_at) <= Date.parse(row.completed_at!) && Date.parse(row.completed_at!) <= Date.parse(p.observed_at)))))
}

export async function recordPipelineProgress(db: D1Database, runDate: string, runId: string, progress: PipelineProgress) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !runId || !validPipelineProgress(progress)) throw new Error('invalid_pipeline_progress')
  const observed = new Date(progress.observed_at).toISOString()
  // Each execution sends a cumulative local history. Merge it atomically in D1;
  // a new process must not replace receipts from previous continuations.
  const rank = ({startup:0,node_load_inputs:10,node_load_market_env:10,node_capture_atomic_inputs:10,
    node_build_payloads:20,input_snapshot:20,input_prep:20,feature_preparation:20,
    node_l2_timesfm_enrich:30,seal_l2_inputs:30,prepare_prediction_request:30,
    dispatch_prediction:40,modal_prediction:40,modal_inference:41,node_l3_formal_predict:42,seal_l3_results:43} as Record<string,number>)[progress.phase] ?? 50
  const payload = { ...progress, phase_rank:rank, executions: { [progress.execution_id]: progress.completed } }
  return Boolean(await db.prepare(`INSERT INTO pipeline_stage_runs
    (business_date,stage,canonical_run_id,status,cursor_key,started_at,updated_at)
    SELECT business_date,'pipeline_progress',canonical_run_id,'running',?,?,?
      FROM pipeline_stage_runs WHERE business_date=? AND stage='pipeline_execution'
       AND canonical_run_id=? AND status IN ('running','waiting')
    ON CONFLICT(business_date,stage) DO UPDATE SET canonical_run_id=excluded.canonical_run_id,
      cursor_key=CASE WHEN pipeline_stage_runs.canonical_run_id=excluded.canonical_run_id
        THEN json_set(CASE WHEN COALESCE(json_extract(pipeline_stage_runs.cursor_key,'$.phase_rank'),0)>json_extract(excluded.cursor_key,'$.phase_rank')
          THEN pipeline_stage_runs.cursor_key ELSE excluded.cursor_key END,
          '$.started_at', min(json_extract(pipeline_stage_runs.cursor_key,'$.started_at'),json_extract(excluded.cursor_key,'$.started_at')),
          '$.executions', json_patch(COALESCE(json_extract(pipeline_stage_runs.cursor_key,'$.executions'),
            json_object(json_extract(pipeline_stage_runs.cursor_key,'$.execution_id'),json_extract(pipeline_stage_runs.cursor_key,'$.completed'))),
            json_extract(excluded.cursor_key,'$.executions')))
        ELSE excluded.cursor_key END,
      started_at=CASE WHEN pipeline_stage_runs.canonical_run_id=excluded.canonical_run_id
        THEN min(pipeline_stage_runs.started_at,excluded.started_at) ELSE excluded.started_at END,
      updated_at=excluded.updated_at
    WHERE pipeline_stage_runs.canonical_run_id<>excluded.canonical_run_id
       OR pipeline_stage_runs.updated_at<excluded.updated_at
    RETURNING canonical_run_id`).bind(JSON.stringify(payload), progress.started_at, observed, runDate, runId).first())
}

export function pipelineProgressForDisplay(parent: { canonical_run_id: string; status: string } | undefined,
  row?: { canonical_run_id: string; cursor_key: string | null },
  handoff?: { runId: string; observedAt: string; phase: string }) {
  if (!parent || !row || row.canonical_run_id !== parent.canonical_run_id) return null
  try {
    const progress: unknown = JSON.parse(row.cursor_key ?? '')
    if (!validPipelineProgress(progress)) return null
    // A finished producer can hand off without phase telemetry (older Jobs).
    // Do not let its earlier node hide a newer, same-run dependency receipt.
    if (handoff?.runId === parent.canonical_run_id && handoff.phase !== progress.phase
      && !(handoff.phase === 'modal_prediction' && ['modal_inference','node_l3_formal_predict','seal_l3_results'].includes(progress.phase))
      && Date.parse(handoff.observedAt) > Date.parse(progress.observed_at)) {
      return { ...progress, phase: progress.phase === 'prepare_prediction_request' && handoff.phase === 'input_prep' ? progress.phase : handoff.phase, status: 'waiting' as const,
        phase_started_at: handoff.observedAt, observed_at: handoff.observedAt,
        execution_id: '', evidence_source: 'scheduler_handoff' }
    }
    return progress
  } catch { return null }
}
