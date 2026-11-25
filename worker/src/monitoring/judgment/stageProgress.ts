// Copied from worker/src/lib/finlabStageProgress.ts (validFinLabStageProgress) and worker/src/lib/pipelineProgress.ts
// (validPipelineProgress): the receipt validators only, so the monitoring Worker never bundles the modules that
// write those receipts. monitoringEndpoints.test.ts compares the function bodies with the originals.
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
