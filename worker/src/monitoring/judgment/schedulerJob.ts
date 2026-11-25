// Copied from frontend/src/lib/api.ts (SchedulerHistoryCell, SchedulerJob) for the monitoring Worker's
// judgment code. The frontend copy stays the display contract until the OBS retirement phase.
export type SchedulerHistoryCell =
  | 'success' | 'failed' | 'running' | 'triggered' | 'waiting' | 'blocked' | 'attention' | 'missing' | 'skip' | 'none'
export type SchedulerJob = {
  /** FU8-A: canonical run id of the durable stage (the pipeline progress owner); null when none. */
  canonicalRunId?: string|null
  /** FU8-A: FinLab run id the Worker used to select finlabProgress. */
  finlabRunId?: string|null
  pipelineWork?: {run_id:string;run_date:string;phase:string;stage_id:string;
    status:'running'|'waiting'|'failed'|'unknown';active:number;completed:number;total:number;
    observed_at:string;execution_id?:string;started_at?:string|null}
  stageCard?: boolean
  stageElapsed?: string
  pipelineBatches?: Array<{stage_id:string;phase:string;completed:number;total:number;observed_at:string}>
  stageVisualStatus?: 'completed'|'noop'|'blocked'|'running'|'waiting'|'not_started'|'stale'
  finlabPhase?: 'acquire'|'validate'|'publish'
  finlabProgress?: {run_id:string;run_date:string;dispatch_attempt:number;sequence:number;observed_at:string;
    phases:Array<{phase:'acquire'|'validate'|'publish';status:'running'|'completed'|'failed'|'waiting';
      started_at:string;completed_at?:string;elapsed_ms?:number}>} | null
  pipelinePhase?: 'premarket_l4'
  pipelineProgress?: { run_id?: string; run_date?: string; executions?: Record<string, Array<{phase:string;elapsed_ms:number;status:'completed'|'failed'|'blocked'|'waiting';started_at?:string|null;completed_at?:string}>>; phase: string; status: 'running'|'waiting'|'completed'|'failed'|'blocked'; started_at: string;
    phase_started_at: string; observed_at: string; execution_id: string;
    completed: Array<{phase:string;elapsed_ms:number;status:'completed'|'failed'|'blocked'|'waiting';started_at?:string|null;completed_at?:string}> } | null
  id: string
  name: string
  schedule: string
  cron: string
  group: 'pipeline_chain' | 'intraday' | 'weekly' | 'daily' | 'monthly'
  chainIndex?: number
  lastRun: string
  lastRunAt?: string | null
  lastRunBasis?: 'started' | 'updated'
  lastAttemptAt?: string | null
  lastAttemptStatus?: 'success' | 'error' | 'skipped' | 'triggered' | 'running' | 'none'
  lastEffectiveRunAt?: string | null
  lastEffectiveStatus?: 'success' | 'error' | 'skipped' | 'triggered' | 'running' | 'none'
  lastStatus: 'success' | 'failed' | 'blocked' | 'running' | 'skip' | 'waiting' | 'sleep'
  /** Set on a skip that stands in for work which should have run for real. */
  attentionReason?: string | null
  /** A watchdog with no receipt from inside today's open window. */
  missedWindow?: boolean
  statusScope?: 'today' | 'historical_replay' | 'schedule' | 'cadence_cycle' | 'durable_event'
  statusRunDate?: string | null
  lastDuration: string
  durationConcern?: 'expected_short' | 'suspicious_short' | null
  durationConcernReason?: string
  lastError?: string
  runId?: string | null
  attemptId?: string | null
  attemptCount?: number | null
  recoveredFromStatus?: 'success' | 'failed' | 'blocked' | 'running' | 'skip' | 'waiting' | 'sleep' | null
  statusAuthority?: 'scheduler_kv' | 'durable_pipeline_stage' | 'scheduler_execution_ticket'
  displayNote?: string | null
  nextRun: string
  history7d: SchedulerHistoryCell[]
  rate7d: string
  summary: string
  details?: string[]
  accounting: {
    schedulerJobId: string | null
    task: string
    physicalRoot: boolean
    desiredState: 'ENABLED' | 'PAUSED' | null
    accountingClass: 'mapped_dependency' | 'standalone_root' | 'unmapped_dependency' | 'internal_chain'
    dependencyReviewed: boolean
    ticketRequired: boolean
  }
  ticket: {
    ticketId: string | null
    physicalRootId: string | null
    logicalTask: string
    status: SchedulerJob['lastStatus']
    runDate: string | null
    authority: 'scheduler_kv' | 'durable_pipeline_stage' | 'scheduler_execution_ticket'
    durable: boolean
    missing: boolean
  }
  consolidation?: {
    task: string
    owner: 'gcp_scheduler' | 'worker_chain' | 'controller_chain' | 'manual_only'
    consolidationClass:
      | 'keep_scheduler'
      | 'merge_into_chain'
      | 'downstream_evidence'
      | 'manual_maintenance_candidate'
      | 'disable_candidate'
    currentFunction: string
    replacementOwner?: string
    upstream: string[]
    downstream: string[]
    requiredBeforeDisable: string[]
    operatorRisk: 'low' | 'medium' | 'high'
    recommendation: string
  } | null
}

