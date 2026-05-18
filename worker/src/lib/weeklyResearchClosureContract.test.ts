const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const gcpCron = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const workerCron = fs.readFileSync('src/lib/cronWorkerDomainTasks.ts', 'utf8')
const adminWorker = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const dailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const index = fs.readFileSync('src/index.ts', 'utf8')

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
  workflows.includes('run_date: options.runDate') &&
    adminGcp.includes("deps.runWeeklyOptunaResearch(requestedRunDate())") &&
    adminGcp.includes("deps.runMonthlyOptunaResearch(requestedRunDate())") &&
    index.includes('runWeeklyOptunaResearchWorkflow(c.env, runDate)') &&
    index.includes('runMonthlyOptunaResearchWorkflow(c.env, runDate)'),
  'manual weekly/monthly Optuna triggers must preserve requested run_date through the controller Job callback',
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
  workflows.includes('nTrials: 80') &&
    workflows.includes('subsetSize: 400') &&
    workflows.includes('populationSize: 12') &&
    workflows.includes('generations: 4'),
  'weekly Optuna must be a lightweight calibration/hotfix sweep; monthly owns heavy search',
)

assert(
  !/runWithLog\('weekly-cleanup'[\s\S]*runWeeklyRetrain/.test(workerCron) &&
    !/'weekly-cleanup':[\s\S]*runWeeklyRetrain/.test(adminWorker),
  'weekly cleanup must not hide universal retrain in scheduled or manual trigger paths; retrain is monthly/manual only',
)

assert(
  workflows.includes("jsonBody: { apply: false, confirm: false }") &&
    dailyWorkflows.includes("jsonBody: { apply: false, confirm: false }") &&
    workerCron.includes('lifecycle dry-run') &&
    adminWorker.includes('lifecycle dry-run') &&
    !workflows.includes("jsonBody: { apply: true, confirm: true }") &&
    !dailyWorkflows.includes("jsonBody: { apply: true, confirm: true }"),
  'weekly cleanup and IC tracker must not mutate production model_pool lifecycle; promotion/retire needs explicit controller action',
)

assert(
  workflows.includes('runWeeklyDriftRetrain') &&
    workflows.includes("candidate_type: 'weekly_drift'") &&
    workflows.includes('force_monthly: false') &&
    workflows.includes('drift_target_models') &&
    workflows.includes('drift_target_families'),
  'weekly drift retrain must be a dedicated weekly_drift candidate path with explicit drift targets, not full monthly retrain',
)

assert(
  adminGcp.includes("'weekly-drift-retrain'") &&
    adminGcp.includes("confirm=weekly_drift required") &&
    triggerRoutes.includes("'weekly-drift-retrain'") &&
    schedulerStatusIncludesManualWeeklyDrift(),
  'weekly drift retrain must be manual/approval-gated and visible in scheduler surfaces',
)

assert(
  triggerRoutes.includes("'weekly-cleanup'") &&
    triggerRoutes.includes("'weekly-backtest'") &&
    triggerRoutes.includes('requires sync=1'),
  'weekly cleanup/backtest must use sync trigger contract so OBS does not infer stale background runs',
)

function schedulerStatusIncludesManualWeeklyDrift(): boolean {
  const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
  return schedulerStatus.includes("'weekly-drift-retrain'") && schedulerStatus.includes('Manual, approval-gated shadow candidate')
}

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
