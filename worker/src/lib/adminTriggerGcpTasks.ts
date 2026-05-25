import { twToday } from './dateUtils'
import {
  runFinLabV4Backfill,
  runModelIcTrackerChain,
  runObsidianDaily,
  runPaperActivePostmarketPromotion,
  runRegimeCompute,
  runVerifyV2,
  runWeeklyDriftRetrain,
  triggerRetrain,
  runWeeklyValidationChain,
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
    'weekly-backtest': async () => runWeeklyValidationChain(c.env, requestedRunDate()),
    'monte-carlo': () => deps.runWeeklyMonteCarlo(),
    pbo: () => deps.runWeeklyPBO(),
    'model-artifact-validation': () => deps.runWeeklyModelArtifactValidation(),
    'finlab-v4-backfill': async () => runFinLabV4Backfill(c.env, requestedRunDate()),
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
