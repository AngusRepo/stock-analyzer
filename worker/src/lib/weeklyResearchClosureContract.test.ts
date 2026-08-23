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
const durableScheduler = fs.readFileSync('src/lib/durableSchedulerTask.ts', 'utf8')
const dailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const index = fs.readFileSync('src/index.ts', 'utf8')
const backtestRouter = fs.readFileSync('../ml-controller/routers/backtest.py', 'utf8')
const optunaJob = fs.readFileSync('../ml-controller/optuna_job_main.py', 'utf8')
const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const localMaintenance = fs.readFileSync('src/lib/localMaintenance.ts', 'utf8')
const deployScript = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')
const adminControl = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const weeklyFence = fs.readFileSync('src/lib/weeklyResearchRunFence.ts', 'utf8')

assert(
  localMaintenance.includes('const D1_SAFE_IN_BIND_LIMIT = 90') &&
    localMaintenance.includes('offset += D1_SAFE_IN_BIND_LIMIT') &&
    localMaintenance.includes('slice(offset, offset + D1_SAFE_IN_BIND_LIMIT)'),
  'weekly cleanup IC/drift sampling must stay below the D1 100-bound-variable ceiling',
)

assert(
  /'alert_notifications_ephemeral',\s*databaseForDataDomain\(env, 'core'\)/.test(localMaintenance) &&
    /'intraday_minute_bar_continuity_90d',\s*databaseForDataDomain\(env, 'market'\)/.test(localMaintenance),
  'weekly cleanup deletes must target the canonical Core and Market D1 owners',
)

assert(
  localMaintenance.includes("const paperDb = databaseForDataDomain(env, 'paper')") &&
    localMaintenance.includes('await paperDb.prepare(`SELECT * FROM ${table}`).all()'),
  'weekly paper snapshot backup must read the canonical Paper D1 owner',
)

assert(
  workflows.includes("'/backtest/research-bundle/run'") &&
    adminGcp.includes('runWeeklyValidationChain(c.env') &&
    gcpCron.includes('runWeeklyValidationChain(env') &&
    wrangler.includes('WEEKLY_BACKTEST_RESEARCH_BUNDLE_ENABLED = "1"'),
  'weekly backtest must hand off to a long-running research Job from both scheduler entry paths',
)

assert(
  deployScript.includes('BACKTEST_RESEARCH_JOB_NAME="${BACKTEST_RESEARCH_JOB_NAME:-weekly-backtest-research}"') &&
    deployScript.includes('sync_backtest_research_job') &&
    deployScript.includes('BACKTEST_RESEARCH_JOB_IMG') &&
    deployScript.includes('BACKTEST_RESEARCH_JOB_COMMAND') &&
    deployScript.includes('add-iam-policy-binding "$BACKTEST_RESEARCH_JOB_NAME"') &&
    deployScript.includes('"roles/run.jobsExecutorWithOverrides"') &&
    deployScript.includes('"roles/run.viewer"'),
  'weekly backtest must have resource-scoped run-with-overrides and execution-list permissions plus image/entrypoint parity checks',
)

assert(
  deployScript.includes('BACKTEST_RESEARCH_JOB_ENV_FILE=') &&
    deployScript.includes('"OPTUNA_JOB_MODE": "weekly_backtest"') &&
    deployScript.includes('"OPTUNA_CALLBACK_TASK": "weekly-backtest"') &&
    deployScript.includes('line.split(":", 1)[0].strip() not in overrides') &&
    deployScript.includes('sync_backtest_research_job "$BACKTEST_RESEARCH_JOB_ENV_FILE"') &&
    deployScript.includes('BACKTEST_RESEARCH_JOB_JSON=$(gcloud run jobs describe') &&
    deployScript.includes('BACKTEST_RESEARCH_JOB_ENV_VALUES=$(BACKTEST_RESEARCH_JOB_JSON=') &&
    deployScript.includes('json.loads(os.environ["BACKTEST_RESEARCH_JOB_JSON"])') &&
    deployScript.includes('if item.get("name") in {"OPTUNA_JOB_MODE", "OPTUNA_CALLBACK_TASK"}') &&
    deployScript.includes('value="${value%$\'\\r\'}"') &&
    deployScript.includes('MODE) BACKTEST_RESEARCH_JOB_MODE="$value"') &&
    deployScript.includes('CALLBACK) BACKTEST_RESEARCH_CALLBACK_TASK="$value"') &&
    !deployScript.includes("env[?name='OPTUNA_JOB_MODE'].value") &&
    !deployScript.includes("env[?name='OPTUNA_CALLBACK_TASK'].value"),
  'dedicated weekly backtest Job must fail closed to weekly_backtest mode even without execution overrides',
)


assert(
  deployScript.includes('BACKTEST_RESEARCH_SECRET_BINDINGS="CF_API_TOKEN=') &&
    deployScript.includes('STOCKVISION_AUTH_TOKEN=${STOCKVISION_AUTH_TOKEN_SECRET}"') &&
    /sync_backtest_research_job[\s\S]+--set-secrets="\$BACKTEST_RESEARCH_SECRET_BINDINGS"/.test(deployScript) &&
    !/sync_backtest_research_job[\s\S]+--update-secrets="\$RUN_SECRET_BINDINGS"[\s\S]+Weekly backtest research job update failed/.test(deployScript),
  'weekly backtest Job update must authoritatively replace broad historical secret bindings with CF_API_TOKEN and STOCKVISION_AUTH_TOKEN only',
)

assert(
  backtestRouter.includes('reject_if_running=True') &&
    backtestRouter.includes('weekly_backtest_research_execution_already_running') &&
    backtestRouter.includes('run_id: str = Field(') &&
    backtestRouter.includes('run_id = req.run_id') &&
    backtestRouter.includes('weekly_backtest_run_id_date_mismatch') &&
    !backtestRouter.includes('run_id = f"weekly-backtest-{run_date}-'),
  'weekly backtest dispatcher must use the Worker-supplied canonical run_id and reject duplicate Job executions',
)

assert(
  backtestRouter.includes('go_live_verdict, raw_details, created_at') &&
    backtestRouter.includes('immutable_pbo_backtest_lineage_mismatch') &&
    backtestRouter.includes('pbo_provenance.get("source_row_id")') &&
    backtestRouter.includes('pbo_provenance.get("source_run_date")'),
  'weekly read-only reconciliation must bind PBO raw_details provenance to the same backtest id and run_date',
)

assert(
  workflows.includes('reserveWeeklyBacktestDispatch') &&
    workflows.includes('markWeeklyBacktestDispatchRunning') &&
    workflows.includes('markWeeklyBacktestDispatchFailed') &&
    workflows.indexOf('reserveWeeklyBacktestDispatch(opsDb') < workflows.indexOf("controllerFetch(env, '/backtest/research-bundle/run'") &&
    workflows.includes('run_id: runId') &&
    adminControl.includes('acceptWeeklyBacktestCallback') &&
    weeklyFence.includes('weekly_backtest_dispatching') &&
    weeklyFence.includes('stale_weekly_backtest_callback') &&
    weeklyFence.includes('INSERT INTO scheduler_locks') &&
    weeklyFence.includes('AND run_id=?'),
  'weekly dispatcher must reserve a canonical run_id fence before dispatch and CAS running/failed before accepting same-run callbacks',
)

assert(
  optunaJob.includes('_callback_weekly_with_bounded_retry') &&
    optunaJob.includes('WEEKLY_BACKTEST_CALLBACK_MAX_ATTEMPTS') &&
    optunaJob.includes('if attempt >= max_attempts or "HTTP 4" in message'),
  'weekly terminal callback must retry transient delivery with a bounded attempt count and not retry stale 4xx callbacks',
)

assert(
  durableScheduler.includes("leaseGroup: `s12_smcvwap_calibration:${runDate}`") &&
    durableScheduler.includes('FROM s12_tw_calibration_runs') &&
    durableScheduler.includes('idempotent: true') &&
    durableScheduler.includes('throw new Error(leased.reason)'),
  'S12 durable calibration must serialize same-date execution and reuse its persistent canonical run row instead of recomputing',
)

assert(
  backtestRouter.includes('@router.post("/research-bundle/run")') &&
    backtestRouter.includes('OPTUNA_JOB_MODE": "weekly_backtest"') &&
    optunaJob.includes('async def _run_weekly_backtest_bundle') &&
    optunaJob.includes('validation_status') &&
    optunaJob.includes('promotion_gate_eligible'),
  'weekly research Job must callback terminal execution separately from risk-gate blockers',
)

assert(
  backtestRouter.includes('@router.post("/research-bundle/reconcile")') &&
    backtestRouter.includes('canonical_weekly_evidence_error') &&
    backtestRouter.includes('"evidence_read_only": True') &&
    workflows.includes('runWeeklyBacktestEvidenceReconciliation') &&
    workflows.includes("'/backtest/research-bundle/reconcile'") &&
    adminGcp.includes("c.req.query('reconcile') === '1'") &&
    adminGcp.includes('runWeeklyBacktestEvidenceReconciliation'),
  'ended weekly cycles must reconcile immutable evidence read-only rather than recompute historical production evidence',
)

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
    workflows.includes('remote_execution_id') &&
    workflows.includes('research_sweep/run'),
  'weekly/monthly Optuna must not synchronously wait for the full heavy sweep; it should return triggered with normalized remote_execution_id and rely on Job callback',
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
    workflows.includes('weekly validation chain failed') &&
    workflows.includes("normalized.includes('gate=fail')"),
  'weekly backtest/MC/PBO must classify partial MC/PBO failures and MC gate failures as errors, not success summaries',
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
    adminWorker.includes('runWeeklyCleanupClosure') &&
    durableScheduler.includes('lifecycle dry-run') &&
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
  workflows.includes('FORMAL_ARTIFACT_LIFECYCLE_BY_NAME') &&
    workflows.includes('artifact_lifecycle_targets') &&
    workflows.includes('sequence_artifact_retrain_registration') &&
    !workflows.includes('foundation_forecast_validation_config_refresh') &&
    workflows.includes('weekly_drift skipped: no supported retrain groups'),
  'weekly drift retrain must route formal L3 artifact slots through artifact lifecycle targets; TimesFM is handled by L2 feature-release governance',
)
assert(
  workflows.includes('ACTIVE_WEEKLY_DRIFT_MODEL_NAMES') &&
    workflows.includes('ACTIVE_WEEKLY_DRIFT_MODEL_NAMES.has(name)') &&
    !/MODEL_GROUP_BY_NAME[\s\S]*CatBoost/.test(workflows) &&
    !/MODEL_GROUP_BY_NAME[\s\S]*Chronos/.test(workflows),
  'weekly drift retrain must filter to active-8 direct-alpha and must not map retired CatBoost/Chronos into retrain groups',
)

assert(
  adminGcp.includes("'weekly-drift-retrain'") &&
    adminGcp.includes('runWeeklyDriftDetection') &&
    adminGcp.includes("confirm') !== 'weekly_drift") &&
    triggerRoutes.includes("'weekly-drift-retrain'") &&
    schedulerStatusIncludesManualWeeklyDrift(),
  'weekly drift retrain must expose detection evidence without approval and remain manual/approval-gated; require confirm=weekly_drift before retrain',
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
