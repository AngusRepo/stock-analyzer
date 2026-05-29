const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const controllerExports = fs.readFileSync('src/lib/controllerWorkflows.ts', 'utf8')
const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
const schedulerRunLogger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const wranglerToml = fs.readFileSync('wrangler.toml', 'utf8')

assert(
  workflows.includes('runFinLabV4Backfill') &&
    workflows.includes("'/finlab/backfill/run'") &&
    workflows.includes('FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED') &&
    workflows.includes("callback_task: 'finlab-v4-backfill'") &&
    workflows.includes("trigger_source: 'worker_scheduler'") &&
    workflows.includes("mode: dailyPriceMode ? 'daily_price_primary' : 'archive_backfill'") &&
    workflows.includes('timeoutMs: 60_000'),
  'FinLab V4 backfill must have a short Worker -> controller Modal trigger path, gated by an explicit env flag',
)

assert(
  workflows.includes('write_d1: true') &&
    workflows.includes('apply_canonical_d1: true') &&
    workflows.includes('finLabBackfillYears') &&
    workflows.includes('FINLAB_BACKFILL_YEARS must be 3 or 5') &&
    workflows.includes('canonical_window_days: finLabCanonicalWindowDays(env)') &&
    workflows.includes('FINLAB_BACKFILL_CANONICAL_WINDOW_DAYS must be between 1 and 30'),
  'FinLab Modal trigger must preserve archive years, D1 summary writeback, canonical D1 apply, and bounded repair window quality',
)

assert(
  workflows.includes('Cloud Run Job remains owner') &&
    controllerExports.includes('runFinLabV4Backfill') &&
    adminGcp.includes("'finlab-v4-backfill'") &&
    adminGcp.includes('runFinLabV4Backfill(c.env, requestedRunDate())'),
  'FinLab Modal trigger must be available for manual/scheduler routing but default to the current Cloud Run owner until explicitly enabled',
)

assert(
  triggerRoutes.includes("'finlab-v4-backfill'") &&
    triggerRoutes.includes('requires sync=1') &&
    adminControlRoutes.includes("'finlab-v4-backfill'") &&
    schedulerRunLogger.includes("'finlab-v4-backfill': 'FinLab V4 Backfill'"),
  'FinLab backfill trigger and callback must be visible in scheduler logs and report artifact callbacks',
)

assert(
  schedulerPolicy.includes("'finlab-v4-backfill'") &&
    schedulerStatus.includes("{ id: 'finlab-v4-backfill'") &&
    schedulerStatus.includes("schedule: 'Inside evening-chain (22:00 callback)'") &&
    schedulerStatus.includes("cron: 'callback'") &&
    schedulerStatus.includes("'finlab-v4-backfill',"),
  'FinLab backfill must be visible as an evening-chain callback, not as a standalone 18:30 Scheduler job',
)

assert(
    wranglerToml.includes('DAILY_PRICE_SOURCE = "finlab"') &&
    wranglerToml.includes('FINLAB_DAILY_PRICE_PRIMARY_ENABLED = "true"') &&
    wranglerToml.includes('FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED = "true"') &&
    wranglerToml.includes('FINLAB_DAILY_PRICE_LANES = "daily_price,emerging_price_diversity"') &&
    wranglerToml.includes('FINLAB_DAILY_PRICE_CANONICAL_DATASETS = "canonical_market_daily"'),
  'Worker production vars must make FinLab the primary daily price owner and enable the Modal trigger path',
)

assert(
  updateOrchestrator.includes('finLabDailyPricePrimaryEnabled') &&
    updateOrchestrator.includes('triggerFinLabPrimaryMarketData') &&
    updateOrchestrator.includes('continueEveningChain: true') &&
    updateOrchestrator.includes('callback will continue indicator queue') &&
    updateOrchestrator.includes('continueEveningChainAfterFinLabBackfill') &&
    updateOrchestrator.includes('runWave2BestEffortAfterFinLabBackfill') &&
    updateOrchestrator.includes('wave2 best-effort timeout after'),
  'evening-chain must route the daily price root through FinLab primary and keep Wave2 best-effort bounded so callback continuation cannot block the main chain',
)

assert(
  workflows.includes("FINLAB_DAILY_PRICE_LANES") &&
    workflows.includes("'daily_price,emerging_price_diversity'") &&
    workflows.includes("FINLAB_DAILY_PRICE_CANONICAL_DATASETS") &&
    workflows.includes("'canonical_market_daily'") &&
    workflows.includes('skip_diff_counts'),
  'daily price mode must use a fast FinLab lane/canonical subset instead of full 3y archive backfill',
)

assert(
    adminControlRoutes.includes('continueEveningChainAfterFinLabBackfill') &&
    adminControlRoutes.includes('shouldContinueEveningChainAfterFinLabCallback') &&
    adminControlRoutes.includes('finLabDailyPriceModeCallback') &&
    adminControlRoutes.includes('continue_evening_chain') &&
    adminControlRoutes.includes('finlab_continuation_queued') &&
    adminControlRoutes.includes("'finlab-primary-continuation'") &&
    schedulerRunLogger.includes("'finlab-primary-continuation': 'FinLab Primary Continuation'"),
  'FinLab callback must continue the evening chain for explicit daily-price callbacks and expose whether continuation was queued',
)
