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
  const requestedRunDate = () => c.req.query('date') || undefined

  return {
    'obsidian-daily': async () => runObsidianDaily(c.env, twToday()),
    'obsidian-sync': async () => runObsidianDaily(c.env, twToday()),
    'regime-compute': async () => runRegimeCompute(c.env),
    'model-ic-tracker': async () => runModelIcTrackerChain(c.env),
    'weekly-audit': () => deps.runWeeklyAudit(),
    'verify-v2': async () => runVerifyV2(c.env, requestedRunDate()),
    backtest: () => deps.runWeeklyBacktest(),
    'weekly-backtest': async () => {
      const bt = await deps.runWeeklyBacktest()
      const mc = await deps.runWeeklyMonteCarlo().catch((e) => { console.warn('[MC]', e); return 'failed' })
      const pbo = await deps.runWeeklyPBO().catch((e) => { console.warn('[PBO]', e); return 'failed' })
      return `bt(${bt}) | mc(${mc}) | pbo(${pbo})`
    },
    'monte-carlo': () => deps.runWeeklyMonteCarlo(),
    pbo: () => deps.runWeeklyPBO(),
    'alpha-quality': () => deps.runWeeklyAlphaQuality(),
    lifecycle: () => deps.runWeeklyLifecycleCheck(),
    'weekly-optuna': () => deps.runWeeklyOptunaResearch(),
    'monthly-optuna': () => deps.runWeeklyOptunaResearch(),
    'optuna-queue': () => deps.runOptunaQueueProcessor(),
    retrain: async () => {
      const force = c.req.query('monthly') === '1'
      return triggerRetrain(c.env, force)
    },
  }
}
