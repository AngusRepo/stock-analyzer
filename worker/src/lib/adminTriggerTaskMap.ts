import { buildAdminGcpTriggerTaskMap } from './adminTriggerGcpTasks'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'

export type TaskHandler = () => Promise<any>

export interface SchedulerCallbackContext {
  schedulerTicketId?: string
  schedulerRunId?: string
}

export interface TriggerDeps {
  runMarketScreener: (runDate?: string) => Promise<any>
  runScreenerV2?: (runDate?: string, options?: { chainRunId?: string }) => Promise<any>
  runDailyUpdate: (force?: boolean, runDate?: string) => Promise<any>
  runMarketCloseRefresh: (force?: boolean, runDate?: string) => Promise<any>
  runMLAndRiskV2: (runDate?: string) => Promise<any>
  runDailyRecommendation: (runDate?: string) => Promise<any>
  runPaperAutoTrade: () => Promise<any>
  setupMorningPendingBuys: () => Promise<any>
  runIntradayCheck: () => Promise<any>
  runEODExit: () => Promise<any>
  runDailySnapshot: (runDate?: string) => Promise<any>
  runMorningWarmup: () => Promise<any>
  runWeeklyAudit: () => Promise<any>
  runWeeklyBacktest: (runDate?: string) => Promise<any>
  runWeeklyMonteCarlo: (runDate?: string) => Promise<any>
  runWeeklyPBO: (runDate?: string) => Promise<any>
  runWeeklyModelArtifactCandidateValidation: () => Promise<any>
  runWeeklyModelArtifactValidation: () => Promise<any>
  runWeeklyAlphaQuality: () => Promise<any>
  runWeeklyModelRegistryCheck: () => Promise<any>
  runWeeklyOptunaResearch: (runDate?: string, schedulerContext?: SchedulerCallbackContext) => Promise<any>
  runMonthlyOptunaResearch: (runDate?: string, schedulerContext?: SchedulerCallbackContext) => Promise<any>
  runL4AlphaEvRefresh: (runDate?: string, cadence?: 'weekly' | 'monthly') => Promise<any>
  runAllocatorEvFusionRefresh: (runDate?: string, cadence?: 'weekly' | 'monthly') => Promise<any>
  runOpbArmPriorRefresh: (
    runDate: string,
    expectedReturnOwner: 'auto' | 'l4_alpha_ev' | 'allocator_ev_fusion',
  ) => Promise<any>
  runAllocatorEvFeatureSnapshotBackfill: (params: {
    startDate: string
    endDate: string
    dryRun?: boolean
    candidateLimit?: number
    l4MinSamples?: number
    l4MinDates?: number
  }) => Promise<any>
  runOptunaQueueProcessor: () => Promise<any>
}

export function buildAdminTriggerTaskMap(
  c: any,
  deps: TriggerDeps,
  schedulerContext: SchedulerCallbackContext = {},
): Record<string, TaskHandler> {
  return {
    ...buildAdminWorkerDomainTaskMap(c, deps),
    ...buildAdminGcpTriggerTaskMap(c, deps, schedulerContext),
  }
}
