import type { SchedulerJob } from '../../lib/api'

export type AttemptAwareChainScope = {
  columns: string[][]
  orchestratorId?: string
}

export type InferOrchestratorStage = (summary?: string | null) => string | null

export function buildAttemptAwareJobMap(
  base: Map<string, SchedulerJob>,
  scope: AttemptAwareChainScope,
  inferOrchestratorStage: InferOrchestratorStage,
): Map<string, SchedulerJob> {
  const orchestrator = scope.orchestratorId ? base.get(scope.orchestratorId) : undefined
  const orchestratorRunning = orchestrator?.lastStatus === 'running'
  const activeRunDate = orchestratorRunning ? orchestrator.statusRunDate : null
  const directRunningStageId = [...scope.columns].reverse().flat()
    .find((stageId) => {
      const job = base.get(stageId)
      if (job?.lastStatus !== 'running') return false
      return !activeRunDate || job.statusRunDate === activeRunDate
    })

  if (!directRunningStageId && !orchestratorRunning) return base

  const currentStageId = directRunningStageId ?? inferOrchestratorStage(orchestrator?.summary)
  const currentColumnIndex = currentStageId
    ? scope.columns.findIndex((column) => column.includes(currentStageId))
    : -1
  if (!currentStageId || currentColumnIndex < 0) return base

  const next = new Map(base)
  const current = next.get(currentStageId)
  const derivedFromParent = !directRunningStageId
  const runtimeAuthority = derivedFromParent ? orchestrator : current
  if (!runtimeAuthority) return base

  // Dispatch is not execution: an authoritative queued receipt for the run
  // named by the parent must keep its waiting state until a worker claims it.
  if (derivedFromParent && current?.lastStatus === 'waiting' && current.ticket?.durable
    && current.runId && runtimeAuthority.summary?.includes(current.runId)
    && current.statusRunDate === runtimeAuthority.statusRunDate) return base

  // A generic finalizer retry is weaker evidence than a terminal receipt from
  // this exact run. Do not restart the completed stage or hide its successors.
  if (derivedFromParent && current?.runId && current.runId === runtimeAuthority.runId
    && current.statusRunDate === runtimeAuthority.statusRunDate
    && ['success', 'failed', 'skip'].includes(current.lastStatus)) return base

  if (current) {
    next.set(currentStageId, {
      ...current,
      lastStatus: 'running',
      lastRun: derivedFromParent ? runtimeAuthority.lastRun : current.lastRun,
      lastRunAt: derivedFromParent ? runtimeAuthority.lastRunAt : current.lastRunAt,
      lastDuration: derivedFromParent ? 'N/A' : current.lastDuration,
      lastError: undefined,
      summary: derivedFromParent ? runtimeAuthority.summary : current.summary,
      statusScope: runtimeAuthority.statusScope,
      statusRunDate: runtimeAuthority.statusRunDate,
      displayNote: derivedFromParent
        ? 'Current stage derived from parent orchestration callback.'
        : 'Current stage confirmed by its direct scheduler head.',
    })
  }

  scope.columns.slice(currentColumnIndex + 1).flat().forEach((jobId) => {
    const job = next.get(jobId)
    if (!job) return
    if (job.runId && job.runId === runtimeAuthority.runId
      && job.statusRunDate === runtimeAuthority.statusRunDate
      && ['success', 'failed', 'skip'].includes(job.lastStatus)) return
    if (runtimeAuthority.id === 'pipeline' && runtimeAuthority.pipelinePhase === 'premarket_l4'
      && jobId === 'ml-predict' && job.lastStatus === 'success'
      && job.statusRunDate === runtimeAuthority.statusRunDate && job.runId === runtimeAuthority.runId) return
    next.set(jobId, {
      ...job,
      lastStatus: 'waiting',
      lastError: undefined,
      summary: `Waiting for current replay stage ${currentStageId}`,
      statusScope: runtimeAuthority.statusScope,
      statusRunDate: runtimeAuthority.statusRunDate,
      displayNote: 'Previous-attempt terminal state is suppressed while the current replay is still upstream.',
    })
  })

  return next
}
