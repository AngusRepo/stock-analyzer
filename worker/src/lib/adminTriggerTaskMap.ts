import { buildAdminGcpTriggerTaskMap } from './adminTriggerGcpTasks'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'

export type TaskHandler = () => Promise<any>

export interface TriggerDeps {
  runMarketScreener: () => Promise<any>
  runDailyUpdate: (force?: boolean, runDate?: string) => Promise<any>
  runMLAndRiskV2: (runDate?: string) => Promise<any>
  runDailyRecommendation: () => Promise<any>
  runPaperAutoTrade: () => Promise<any>
  setupMorningPendingBuys: () => Promise<any>
  runIntradayCheck: () => Promise<any>
  runEODExit: () => Promise<any>
  runDailySnapshot: () => Promise<any>
  runMorningWarmup: () => Promise<any>
  runWeeklyAudit: () => Promise<any>
  runWeeklyBacktest: () => Promise<any>
  runWeeklyMonteCarlo: () => Promise<any>
  runWeeklyPBO: () => Promise<any>
  runWeeklyAlphaQuality: () => Promise<any>
  runWeeklyLifecycleCheck: () => Promise<any>
  runWeeklyOptunaResearch: () => Promise<any>
  runOptunaQueueProcessor: () => Promise<any>
}

export function buildAdminTriggerTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  return {
    ...buildAdminWorkerDomainTaskMap(c, deps),
    ...buildAdminGcpTriggerTaskMap(c, deps),
  }
}
