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

assert(
  workflows.includes('runFinLabV4Backfill') &&
    workflows.includes("'/finlab/backfill/run'") &&
    workflows.includes('FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED') &&
    workflows.includes("callback_task: 'finlab-v4-backfill'") &&
    workflows.includes("trigger_source: 'worker_scheduler'") &&
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
    schedulerStatus.includes("cron: '30 10 * * 1-5'"),
  'FinLab backfill must be registered in scheduler policy and dashboard readback before production scheduler cutover',
)
