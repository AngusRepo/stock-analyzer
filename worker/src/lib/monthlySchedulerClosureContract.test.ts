const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const adminGcp = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const controlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const runLogger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const followup = fs.readFileSync('../ml-controller/routers/retrain_followup.py', 'utf8')

const monthlyRetrain = manifest.jobs.find((job: any) => job.id === 'monthly-retrain')
assert(monthlyRetrain?.task === 'monthly-retrain', 'monthly-retrain manifest must use monthly-retrain as the canonical task id')
assert(monthlyRetrain?.query !== 'monthly=1', 'monthly-retrain should not rely on a retrain?monthly=1 compat route')

assert(adminGcp.includes("'monthly-retrain'"), 'Worker admin GCP task map must expose a monthly-retrain handler')
assert(triggerRoutes.includes("'monthly-retrain'"), 'monthly-retrain must be treated as a long-running task')
assert(runLogger.includes("'monthly-retrain'"), 'scheduler run logger must display monthly-retrain as its own task')
assert(controlRoutes.includes("'monthly-retrain'"), 'scheduler callback report artifacts must include monthly-retrain')

assert(workflows.includes('runMonthlyOptunaResearch'), 'monthly optuna must have an explicit monthly workflow')
assert(
  adminGcp.includes("'monthly-optuna': () => deps.runMonthlyOptunaResearch(requestedRunDate())"),
  'monthly-optuna must not alias weekly optuna and must preserve requested run_date',
)
assert(workflows.includes("cadence: 'monthly'"), 'monthly optuna must pass a monthly cadence contract')

assert(followup.includes('/api/admin/scheduler-callback'), 'retrain followup must notify Worker scheduler callback')
assert(followup.includes('"monthly-retrain"'), 'monthly retrain followup must callback task=monthly-retrain')
assert(followup.includes('"retrain"'), 'non-monthly retrain followup must still callback task=retrain for compatibility')
assert(followup.includes('champion_pointer_reconcile'), 'retrain followup must reconcile champion pointers after artifact lifecycle cutover')
assert(followup.includes('_backfill_champion_pointers_after_cutover'), 'artifact lifecycle cutover must not require manual champion pointer backfill')
assert(
  workflows.includes("artifact_lifecycle_targets: ['GNN', 'TabM', 'PatchTST', 'iTransformer']") &&
    workflows.includes("train_model_groups: ['tree', 'dlinear', 'patchtst']") &&
    !workflows.includes('foundation_forecast_validation_config_refresh') &&
    workflows.includes('sequence_artifact_retrain_registration'),
  'monthly retrain must keep TimesFM out of formal artifact lifecycle targets; TimesFM belongs to the L2 sidecar feature-release path',
)
