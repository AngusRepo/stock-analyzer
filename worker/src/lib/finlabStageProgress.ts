/** Display receipts only. This module never dispatches or settles business tasks. */
export const FINLAB_PHASES = ['acquire', 'validate', 'publish'] as const
export type FinLabStageProgress = {
  run_id: string; run_date: string; dispatch_attempt: number; sequence: number; observed_at: string
  phases: Array<{ phase: typeof FINLAB_PHASES[number]; status: 'running'|'completed'|'failed'|'waiting';
    started_at: string; completed_at?: string; elapsed_ms?: number }>
}
const stamp = (v: unknown): v is string => typeof v === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))
export function validFinLabStageProgress(value: unknown): value is FinLabStageProgress {
  const p = value as FinLabStageProgress
  return Boolean(p && typeof p.run_id === 'string' && p.run_id.length > 0 && p.run_id.length <= 200
    && /^\d{4}-\d{2}-\d{2}$/.test(p.run_date) && Number.isSafeInteger(p.dispatch_attempt) && p.dispatch_attempt > 0
    && Number.isSafeInteger(p.sequence) && p.sequence > 0 && stamp(p.observed_at)
    && Array.isArray(p.phases) && p.phases.length > 0 && p.phases.length <= 3
    && p.phases.every((r, i) => r && r.phase === FINLAB_PHASES[i] && stamp(r.started_at)
      && Date.parse(r.started_at) <= Date.parse(p.observed_at)
      && (i === 0 || Date.parse(p.phases[i-1].completed_at ?? '') <= Date.parse(r.started_at))
      && (r.status === 'running' ? i === p.phases.length-1 && r.completed_at == null && r.elapsed_ms == null
        : ['completed','failed','waiting'].includes(r.status) && (r.status !== 'waiting' || i === p.phases.length-1)
          && stamp(r.completed_at) && Date.parse(r.completed_at) >= Date.parse(r.started_at)
          && Date.parse(r.completed_at) <= Date.parse(p.observed_at)
          && Number.isSafeInteger(r.elapsed_ms) && r.elapsed_ms! >= 0)))
}
type Parent = { run_id?: string; summary?: string; status?: string }
export function matchesFinLabParent(p: FinLabStageProgress, parent: Parent | null | undefined) {
  const attempt = Number(parent?.summary?.match(/(?:^|\s)dispatch_attempt=(\d+)/)?.[1] ?? 1)
  return parent?.run_id === p.run_id && attempt === p.dispatch_attempt
}
export async function recordFinLabStageProgress(db: D1Database, p: FinLabStageProgress) {
  const raw = JSON.stringify(p)
  const last = p.phases[p.phases.length - 1]
  const status = last.status === 'running' ? 'running' : p.phases.some(r => r.status === 'failed') ? 'error'
    : last.status === 'completed' && last.phase === 'publish' ? 'success' : 'waiting'
  return Boolean(await db.prepare(`INSERT INTO pipeline_stage_runs
    (business_date,stage,canonical_run_id,status,cursor_key,started_at,updated_at)
    VALUES (?,'finlab_progress',?,?,?,?,?)
    ON CONFLICT(business_date,stage) DO UPDATE SET canonical_run_id=excluded.canonical_run_id,
      status=excluded.status,
      cursor_key=excluded.cursor_key, started_at=excluded.started_at, updated_at=excluded.updated_at
    WHERE pipeline_stage_runs.canonical_run_id<>excluded.canonical_run_id
       OR json_extract(excluded.cursor_key,'$.dispatch_attempt')>json_extract(pipeline_stage_runs.cursor_key,'$.dispatch_attempt')
       OR (json_extract(excluded.cursor_key,'$.dispatch_attempt')=json_extract(pipeline_stage_runs.cursor_key,'$.dispatch_attempt')
           AND json_extract(excluded.cursor_key,'$.sequence')>json_extract(pipeline_stage_runs.cursor_key,'$.sequence'))
    RETURNING canonical_run_id`).bind(p.run_date,p.run_id,status,raw,p.phases[0].started_at,new Date(p.observed_at).toISOString()).first())
}
export function finlabProgressForDisplay(parent: Parent | undefined, row?: { cursor_key: string | null }) {
  try {
    const p: unknown = JSON.parse(row?.cursor_key ?? '')
    return validFinLabStageProgress(p) && matchesFinLabParent(p,parent) ? p : null
  } catch { return null }
}
