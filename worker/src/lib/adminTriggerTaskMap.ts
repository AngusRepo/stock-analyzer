import { buildAdminGcpTriggerTaskMap } from './adminTriggerGcpTasks'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'

export type TaskHandler = () => Promise<any>

export interface TriggerDeps {
  runMarketScreener: (runDate?: string) => Promise<any>
  runScreenerV2?: (runDate?: string, options?: { chainRunId?: string }) => Promise<any>
  runDailyUpdate: (force?: boolean, runDate?: string) => Promise<any>
  runMLAndRiskV2: (runDate?: string) => Promise<any>
  runDailyRecommendation: (runDate?: string) => Promise<any>
  runPaperAutoTrade: () => Promise<any>
  setupMorningPendingBuys: () => Promise<any>
  runIntradayCheck: () => Promise<any>
  runEODExit: () => Promise<any>
  runDailySnapshot: (runDate?: string) => Promise<any>
  runMorningWarmup: () => Promise<any>
  runWeeklyAudit: () => Promise<any>
  runWeeklyBacktest: () => Promise<any>
  runWeeklyMonteCarlo: () => Promise<any>
  runWeeklyPBO: () => Promise<any>
  runWeeklyModelArtifactCandidateValidation: () => Promise<any>
  runWeeklyModelArtifactValidation: () => Promise<any>
  runWeeklyAlphaQuality: () => Promise<any>
  runWeeklyLifecycleCheck: () => Promise<any>
  runWeeklyOptunaResearch: (runDate?: string) => Promise<any>
  runMonthlyOptunaResearch: (runDate?: string) => Promise<any>
  runOptunaQueueProcessor: () => Promise<any>
}

export function buildAdminTriggerTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  return {
    ...buildAdminWorkerDomainTaskMap(c, deps),
    ...buildAdminGcpTriggerTaskMap(c, deps),
  }
}
