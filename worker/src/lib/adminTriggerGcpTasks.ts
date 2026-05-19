import { twToday } from './dateUtils'
import {
  runModelIcTrackerChain,
  runObsidianDaily,
  runPaperActivePostmarketPromotion,
  runRegimeCompute,
  runVerifyV2,
  runWeeklyDriftRetrain,
  summarizeWeeklyValidationChain,
  triggerRetrain,
} from './controllerWorkflows'
import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'

export function buildAdminGcpTriggerTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  const requestedRunDate = () => c.req.query('date') || undefined

  return {
    'obsidian-daily': async () => runObsidianDaily(c.env, twToday()),
    'obsidian-sync': async () => runObsidianDaily(c.env, twToday()),
    'regime-compute': async () => runRegimeCompute(c.env, requestedRunDate()),
    'model-ic-tracker': async () => runModelIcTrackerChain(c.env),
    'paper-active-postmarket': async () => runPaperActivePostmarketPromotion(c.env, requestedRunDate()),
    'weekly-audit': () => deps.runWeeklyAudit(),
    'verify-v2': async () => runVerifyV2(c.env, requestedRunDate()),
    backtest: () => deps.runWeeklyBacktest(),
    'weekly-backtest': async () => {
      const bt = await deps.runWeeklyBacktest()
      const mc = await deps.runWeeklyMonteCarlo()
      const pbo = await deps.runWeeklyPBO()
      return summarizeWeeklyValidationChain({ backtest: bt, monteCarlo: mc, pbo })
    },
    'monte-carlo': () => deps.runWeeklyMonteCarlo(),
    pbo: () => deps.runWeeklyPBO(),
    'alpha-quality': () => deps.runWeeklyAlphaQuality(),
    lifecycle: () => deps.runWeeklyLifecycleCheck(),
    'weekly-optuna': () => deps.runWeeklyOptunaResearch(requestedRunDate()),
    'weekly-drift-retrain': async () => {
      if (c.req.query('confirm') !== 'weekly_drift') {
        return 'weekly_drift skipped: confirm=weekly_drift required; no retrain triggered'
      }
      return runWeeklyDriftRetrain(c.env, requestedRunDate())
    },
    'monthly-optuna': () => deps.runMonthlyOptunaResearch(requestedRunDate()),
    'optuna-queue': () => deps.runOptunaQueueProcessor(),
    'monthly-retrain': async () => triggerRetrain(c.env, true, 'monthly-retrain'),
    retrain: async () => {
      const force = c.req.query('monthly') === '1'
      return triggerRetrain(c.env, force, force ? 'monthly-retrain' : 'retrain')
    },
  }
}
