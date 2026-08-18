import { twToday } from './dateUtils'
import {
  runModelIcFullCheck,
  runActive8OofLifecycle,
  runObsidianDaily,
  runPaperActivePostmarketPromotion,
  runFinLabV4Backfill,
  runRegimeCompute,
  runVerifyV2,
  runWeeklyDriftDetection,
  runWeeklyDriftRetrain,
  runMonthlyStrategyMining,
  runExternalEvidenceMaterialize,
  summarizeWeeklyValidationChain,
  triggerRetrain,
} from './controllerWorkflows'
import type { TaskHandler, TriggerDeps } from './adminTriggerTaskMap'

function parseBoundedInt(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function buildAdminGcpTriggerTaskMap(c: any, deps: TriggerDeps): Record<string, TaskHandler> {
  const requestedRunDate = () => c.req.query('date') || undefined

  return {
    'obsidian-daily': async () => runObsidianDaily(c.env, twToday()),
    'obsidian-sync': async () => runObsidianDaily(c.env, twToday()),
    'regime-compute': async () => runRegimeCompute(c.env, requestedRunDate()),
    'model-ic-full-check': async () => runModelIcFullCheck(c.env),
    'finlab-v4-backfill': async () => runFinLabV4Backfill(
      c.env,
      requestedRunDate(),
      c.req.query('force') === '1',
      { continueEveningChain: c.req.query('continue_evening_chain') === '1' },
    ),
    'finlab-backfill-watchdog': async () => {
      const { runFinLabBackfillWatchdog } = await import('./updateOrchestrator')
      return runFinLabBackfillWatchdog(c.env, requestedRunDate())
    },
    'active8-oof-lifecycle': async () => {
      const rawCadence = c.req.query('cadence')
      const cadence = rawCadence === 'monthly' ? 'monthly' : rawCadence === 'weekly' ? 'weekly' : 'daily'
      return runActive8OofLifecycle(c.env, requestedRunDate(), cadence)
    },
    'active8-oof-daily': () => runActive8OofLifecycle(c.env, requestedRunDate(), 'daily'),
    'active8-oof-weekly': () => runActive8OofLifecycle(c.env, requestedRunDate(), 'weekly'),
    'active8-oof-monthly': () => runActive8OofLifecycle(c.env, requestedRunDate(), 'monthly'),
    'meta-learning-shadow': async () => {
      const runDate = requestedRunDate() || twToday()
      const runId = `meta-learning-shadow-${runDate}-${Date.now()}`
      await c.env.UPDATE_QUEUE.send({
        type: 'meta_learning_shadow_closure',
        cursor: 0,
        triggerTime: runDate,
        runId,
        force: false,
      })
      return `triggered meta-learning-shadow queue run_date=${runDate} run_id=${runId}`
    },
    'allocator-ev-readiness': async () => {
      const { runDailyAllocatorEvReadiness } = await import('./updateOrchestrator')
      return runDailyAllocatorEvReadiness(c.env, requestedRunDate() || twToday())
    },
    'allocator-ev-lifecycle-watchdog': async () => {
      const { runAllocatorEvLifecycleWatchdog } = await import('./allocatorEvDailyLifecycle')
      return runAllocatorEvLifecycleWatchdog(c.env, requestedRunDate())
    },
    'paper-active-postmarket': async () => runPaperActivePostmarketPromotion(c.env, requestedRunDate()),
    'weekly-audit': () => deps.runWeeklyAudit(),
    'verify-v2': async () => runVerifyV2(c.env, requestedRunDate()),
    backtest: () => deps.runWeeklyBacktest(requestedRunDate()),
    'weekly-backtest': async () => {
      const bt = await deps.runWeeklyBacktest(requestedRunDate())
      const mc = await deps.runWeeklyMonteCarlo(requestedRunDate())
      const pbo = await deps.runWeeklyPBO(requestedRunDate())
      return summarizeWeeklyValidationChain({ backtest: bt, monteCarlo: mc, pbo })
    },
    'monte-carlo': () => deps.runWeeklyMonteCarlo(requestedRunDate()),
    pbo: () => deps.runWeeklyPBO(requestedRunDate()),
    'alpha-quality': () => deps.runWeeklyAlphaQuality(),
    lifecycle: () => deps.runWeeklyLifecycleCheck(),
    'weekly-optuna': () => deps.runWeeklyOptunaResearch(requestedRunDate()),
    'l4-alpha-ev-refresh': () => deps.runL4AlphaEvRefresh(requestedRunDate(), 'weekly'),
    'allocator-ev-fusion-refresh': () => deps.runAllocatorEvFusionRefresh(requestedRunDate(), 'weekly'),
    'opb-arm-prior-refresh': () => deps.runOpbArmPriorRefresh(
      requestedRunDate() || twToday(),
      c.req.query('expected_return_owner') === 'allocator_ev_fusion'
        ? 'allocator_ev_fusion'
        : 'auto',
    ),
    'allocator-ev-feature-snapshot-backfill': () => deps.runAllocatorEvFeatureSnapshotBackfill({
      startDate: c.req.query('start_date') || requestedRunDate() || twToday(),
      endDate: c.req.query('end_date') || requestedRunDate() || twToday(),
      dryRun: c.req.query('dry_run') !== '0',
      candidateLimit: parseBoundedInt(c.req.query('candidate_limit'), 1000, 1, 5000),
      l4MinSamples: parseBoundedInt(c.req.query('l4_min_samples'), 500, 50, 10000),
      l4MinDates: parseBoundedInt(c.req.query('l4_min_dates'), 20, 5, 252),
    }),
    'weekly-drift-retrain': async () => {
      if (c.req.query('confirm') !== 'weekly_drift') {
        return runWeeklyDriftDetection(c.env)
      }
      return runWeeklyDriftRetrain(c.env, requestedRunDate())
    },
    'monthly-optuna': () => deps.runMonthlyOptunaResearch(requestedRunDate()),
    'monthly-l4-alpha-ev-refresh': () => deps.runL4AlphaEvRefresh(requestedRunDate(), 'monthly'),
    'monthly-allocator-ev-fusion-refresh': () => deps.runAllocatorEvFusionRefresh(requestedRunDate(), 'monthly'),
    'monthly-opb-arm-prior-refresh': () => deps.runOpbArmPriorRefresh(
      requestedRunDate() || twToday(),
      c.req.query('expected_return_owner') === 'allocator_ev_fusion'
        ? 'allocator_ev_fusion'
        : 'auto',
    ),
    'monthly-strategy-mining': () => runMonthlyStrategyMining(c.env, requestedRunDate()),
    'external-evidence': () => runExternalEvidenceMaterialize(c.env, requestedRunDate()),
    'optuna-queue': () => deps.runOptunaQueueProcessor(),
    'monthly-retrain': async () => triggerRetrain(c.env, true, 'monthly-retrain'),
    retrain: async () => {
      const force = c.req.query('monthly') === '1'
      return triggerRetrain(c.env, force, force ? 'monthly-retrain' : 'retrain')
    },
  }
}
