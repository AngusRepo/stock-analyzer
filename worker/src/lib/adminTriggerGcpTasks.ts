import { twToday } from './dateUtils'
import {
  runModelIcTrackerChain,
  runObsidianDaily,
  runRegimeCompute,
  runVerifyV2,
  triggerRetrain,
} from './controllerWorkflows'
import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'

export function buildAdminGcpTriggerTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  return {
    'obsidian-daily': async () => runObsidianDaily(c.env, twToday()),
    'obsidian-sync': async () => runObsidianDaily(c.env, twToday()),
    'regime-compute': async () => runRegimeCompute(c.env),
    'model-ic-tracker': async () => runModelIcTrackerChain(c.env),
    'weekly-audit': () => deps.runWeeklyAudit(),
    'verify-v2': async () => runVerifyV2(c.env),
    backtest: () => deps.runWeeklyBacktest(),
    'monte-carlo': () => deps.runWeeklyMonteCarlo(),
    pbo: () => deps.runWeeklyPBO(),
    'alpha-quality': () => deps.runWeeklyAlphaQuality(),
    lifecycle: () => deps.runWeeklyLifecycleCheck(),
    'weekly-optuna': () => deps.runWeeklyOptunaResearch(),
    'optuna-queue': () => deps.runOptunaQueueProcessor(),
    retrain: async () => {
      const force = c.req.query('monthly') === '1'
      return triggerRetrain(c.env, force)
    },
  }
}
