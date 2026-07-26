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
  const directRunningStageId = [...scope.columns].reverse().flat()
    .find((stageId) => base.get(stageId)?.lastStatus === 'running')
  const orchestratorRunning = orchestrator?.lastStatus === 'running'

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

  if (current) {
    next.set(currentStageId, {
      ...current,
      lastStatus: 'running',
      lastRun: derivedFromParent ? runtimeAuthority.lastRun : current.lastRun,
      lastRunAt: derivedFromParent ? runtimeAuthority.lastRunAt : current.lastRunAt,
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
