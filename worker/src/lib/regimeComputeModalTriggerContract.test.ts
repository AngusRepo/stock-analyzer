const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const dailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const adminOptunaRoutes = fs.readFileSync('src/routes/adminOptunaRoutes.ts', 'utf8')
const schedulerRunLogger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')

assert(
  dailyWorkflows.includes('regimeComputeModalTriggerEnabled') &&
    dailyWorkflows.includes("'/regime/compute/run'") &&
    dailyWorkflows.includes('REGIME_COMPUTE_MODAL_TRIGGER_ENABLED') &&
    dailyWorkflows.includes('REGIME_COMPUTE_EXECUTOR') &&
    dailyWorkflows.includes("callback_task: 'regime-compute'") &&
    dailyWorkflows.includes("trigger_source: 'worker_scheduler'") &&
    dailyWorkflows.includes('prev_label: prevLabel') &&
    dailyWorkflows.includes('timeoutMs: 60_000'),
  'regime compute must have a short Worker -> controller Modal trigger path, gated by explicit env flags',
)

assert(
  dailyWorkflows.includes("'/regime/compute'") &&
    dailyWorkflows.includes('detectRegimeShift(env, prevLabel, newLabel)') &&
    dailyWorkflows.includes('history_days: 180'),
  'regime compute must keep the existing synchronous rollback path and legacy shift detection contract',
)

assert(
  adminControlRoutes.includes("'regime-compute'") &&
    adminControlRoutes.includes('REPORT_ARTIFACT_TASKS') &&
    adminControlRoutes.includes("String(body.task) === 'regime-compute'") &&
    adminControlRoutes.includes('callbackMetadata?.prev_label') &&
    adminControlRoutes.includes('callbackMetadata?.regime_label_en') &&
    adminControlRoutes.includes('detectRegimeShift(c.env, prevLabel, newLabel)'),
  'regime compute callback must persist report artifacts and close regime shift detection after Modal push',
)

assert(
  schedulerRunLogger.includes("'regime-compute': 'HMM Regime'"),
  'regime compute must remain visible under the existing scheduler task name',
)

assert(
  adminOptunaRoutes.includes("if (source === 'regime')") &&
    adminOptunaRoutes.indexOf("if (source === 'regime')") < adminOptunaRoutes.indexOf('getTradingConfig'),
  'regime optuna-push must write market_regime_state before loading unrelated trading config',
)
