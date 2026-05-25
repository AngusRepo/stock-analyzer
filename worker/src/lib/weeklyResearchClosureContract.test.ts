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
const dashboardReadRoutes = fs.readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')

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

assert(
  workflows.includes('runWeeklyModelArtifactValidation') &&
    workflows.includes('runWeeklyModelArtifactCandidateValidation') &&
    workflows.includes("'/model_pool/artifact_registry/candidate_validation_chain'") &&
    workflows.includes("'/model_pool/artifact_registry/validation_chain'") &&
    workflows.includes('runWeeklyValidationChain') &&
    workflows.includes('runWeeklyModelArtifactValidation(env)') &&
    workflows.indexOf("'/model_pool/artifact_registry/candidate_validation_chain'") <
      workflows.indexOf("'/model_pool/artifact_registry/validation_chain'") &&
    adminGcp.includes("'model-artifact-candidate-validation'") &&
    triggerRoutes.includes("'model-artifact-candidate-validation'") &&
    index.includes('runWeeklyModelArtifactCandidateValidationWorkflow') &&
    adminControlRoutes.includes('runWeeklyModelArtifactValidation') &&
    adminControlRoutes.includes("String(body.task) === 'weekly-backtest'") &&
    adminControlRoutes.includes("String(callbackMetadata?.source ?? '') === 'backtest_research_bundle'"),
  'weekly-backtest must generate ModelPool artifact candidate-specific evidence before the aggregate validation gate after global backtest/MC/PBO or after the Modal bundle callback instead of leaving artifact evidence manual',
)

assert(
  workflows.includes('weeklyBacktestResearchBundleEnabled') &&
    workflows.includes("'/backtest/research-bundle/run'") &&
    workflows.includes('monte_carlo_n: 1000') &&
    workflows.includes('pbo_partitions: 10') &&
    workflows.includes("callback_task: 'weekly-backtest'") &&
    workflows.includes("trigger_source: 'worker_weekly_backtest'") &&
    gcpCron.includes('runWeeklyValidationChain(env)') &&
    adminGcp.includes('runWeeklyValidationChain(c.env, requestedRunDate())'),
  'weekly-backtest must support an optional Modal research bundle trigger while preserving full MC/PBO settings and callback ownership',
)

assert(
  workflows.includes('if (weeklyBacktestResearchBundleEnabled(env))') &&
    workflows.includes('const bt = await runWeeklyBacktest(env)') &&
    workflows.includes('const mc = await runWeeklyMonteCarlo(env)') &&
    workflows.includes('const pbo = await runWeeklyPBO(env)') &&
    workflows.includes('const artifactValidation = await runWeeklyModelArtifactValidation(env)'),
  'weekly-backtest Modal bundle must be feature-flagged; the default legacy chain must remain available until production is explicitly flipped',
)

assert(
  adminControlRoutes.includes("'weekly-backtest'") &&
    adminControlRoutes.includes('REPORT_ARTIFACT_TASKS'),
  'weekly-backtest callbacks must persist scheduler report artifacts for readback after async bundle completion',
)

assert(
  !workflows.includes('method=block_bootstrap') &&
    workflows.includes('`/backtest/monte-carlo?n=1000&source=${source}`'),
  'weekly Monte Carlo should let the controller auto-select regime-aware backtest MC instead of hard-coding block bootstrap',
)

assert(
  dashboardReadRoutes.includes("WHEN source='backtest_curated' THEN 0") &&
    dashboardReadRoutes.includes("WHEN source='backtest' THEN 1") &&
    dashboardReadRoutes.includes('raw_distribution_json') &&
    dashboardReadRoutes.includes('tail_risk_diagnostics') &&
    dashboardReadRoutes.includes('regime_closed_loop'),
  'dashboard MC readback should prefer curated/backtest MC and expose closed-loop diagnostics',
)
