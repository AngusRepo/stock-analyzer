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
  workflows.includes("'/optuna/research_sweep/run'") &&
    !workflows.includes("Promise.allSettled(sources.map") &&
    !workflows.includes("`/optuna/${src}`"),
  'weekly/monthly Optuna must trigger one controller-owned research_sweep Job endpoint, not Worker fan-out across nine endpoints',
)

assert(
  workflows.includes('callback expected') &&
    workflows.includes('execution_id') &&
    workflows.includes('research_sweep/run'),
  'weekly/monthly Optuna must not synchronously wait for the full heavy sweep; it should return triggered and rely on Job callback',
)

assert(
  workflows.includes('SKIPPED_NOT_READY') &&
    workflows.includes('isInsufficientDataResponse'),
  'weekly Optuna research must distinguish insufficient evidence gates from hard endpoint failures',
)

assert(
  workflows.includes('optuna research Job triggered') &&
    workflows.includes('callback expected'),
  'GA optimizer success must be determined by the optuna Job callback, not by a request-scoped Worker wait',
)

assert(
  workflows.includes('summarizeWeeklyValidationChain') &&
    workflows.includes('weekly validation chain failed'),
  'weekly backtest/MC/PBO must classify partial MC/PBO failures as an error, not a success summary',
)

assert(
  workflows.includes("research_data_source: 'snapshot'") &&
    workflows.includes('requires compute snapshots') &&
    !workflows.includes('OPTUNA_SOURCE_BOUNDS'),
  'weekly/monthly Optuna must optimize heavy routes by forcing snapshot data access, not by silently shrinking trials/subsets',
)

assert(
  workflows.includes('timeoutMs: 60_000'),
  'weekly/monthly Optuna trigger should be short-lived; the long-running sweep belongs in Cloud Run Job',
)

assert(
  workflows.includes('max_parallel_sources: 3'),
  'weekly/monthly Optuna must request bounded controller-side parallelism, not controller serial execution or Worker fan-out',
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
