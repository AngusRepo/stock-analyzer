/** Observability only: no dispatch lease, continuation, or terminal mutation. */
export type PipelineProgress = {
  phase: string; status: 'running' | 'waiting' | 'completed' | 'failed'
  started_at: string; phase_started_at: string; observed_at: string; execution_id: string
  completed: Array<{ phase: string; elapsed_ms: number; status: 'completed' | 'failed' }>
}

export function validPipelineProgress(value: unknown): value is PipelineProgress {
  const p = value as PipelineProgress
  const phase = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(v)
  const stamp = (v: unknown) => typeof v === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
  return Boolean(p && phase(p.phase) && ['running','waiting','completed','failed'].includes(p.status)
    && stamp(p.started_at) && stamp(p.phase_started_at) && stamp(p.observed_at)
    && Date.parse(p.started_at) <= Date.parse(p.phase_started_at) && Date.parse(p.phase_started_at) <= Date.parse(p.observed_at)
    && typeof p.execution_id === 'string' && p.execution_id.length <= 200
    && Array.isArray(p.completed) && p.completed.length <= 32 && p.completed.every(row => row && phase(row.phase)
      && Number.isSafeInteger(row.elapsed_ms) && row.elapsed_ms >= 0 && ['completed','failed'].includes(row.status)))
}

export async function recordPipelineProgress(db: D1Database, runDate: string, runId: string, progress: PipelineProgress) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate) || !runId || !validPipelineProgress(progress)) throw new Error('invalid_pipeline_progress')
  const observed = new Date(progress.observed_at).toISOString()
  return Boolean(await db.prepare(`INSERT INTO pipeline_stage_runs
    (business_date,stage,canonical_run_id,status,cursor_key,started_at,updated_at)
    SELECT business_date,'pipeline_progress',canonical_run_id,'running',?,?,?
      FROM pipeline_stage_runs WHERE business_date=? AND stage='pipeline_execution'
       AND canonical_run_id=? AND status IN ('running','waiting')
    ON CONFLICT(business_date,stage) DO UPDATE SET canonical_run_id=excluded.canonical_run_id,
      cursor_key=excluded.cursor_key, started_at=excluded.started_at, updated_at=excluded.updated_at
    WHERE pipeline_stage_runs.canonical_run_id<>excluded.canonical_run_id
       OR pipeline_stage_runs.updated_at<excluded.updated_at
    RETURNING canonical_run_id`).bind(JSON.stringify(progress), progress.started_at, observed, runDate, runId).first())
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
      && Date.parse(handoff.observedAt) > Date.parse(progress.observed_at)) return null
    return progress
  } catch { return null }
}
