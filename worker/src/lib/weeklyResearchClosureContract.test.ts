const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const gcpCron = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')

assert(
  workflows.includes("'ga_optimizer'"),
  'weekly Optuna research must include GA optimizer so optimizer:ga:latest can learn on the weekly cadence',
)

assert(
  workflows.includes('research failure') &&
    workflows.includes('throw new Error') &&
    workflows.includes('HTTP'),
  'weekly Optuna research must fail-close when any source errors or returns HTTP failure',
)

assert(
  workflows.includes('summarizeWeeklyValidationChain') &&
    workflows.includes('weekly validation chain failed'),
  'weekly backtest/MC/PBO must classify partial MC/PBO failures as an error, not a success summary',
)

assert(
  !gcpCron.includes("runWeeklyMonteCarlo(env).catch") &&
    !gcpCron.includes("runWeeklyPBO(env).catch"),
  'scheduled weekly-backtest must not swallow MC/PBO failures into a successful scheduler run',
)

assert(
  !adminGcp.includes("deps.runWeeklyMonteCarlo().catch") &&
    !adminGcp.includes("deps.runWeeklyPBO().catch"),
  'manual weekly-backtest trigger must not swallow MC/PBO failures into a successful scheduler run',
)
