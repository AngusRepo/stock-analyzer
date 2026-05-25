import fs from 'node:fs'
import assert from 'node:assert/strict'

const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const optunaQueue = fs.readFileSync('src/lib/optunaQueue.ts', 'utf8')
const optunaRunClosure = fs.readFileSync('src/lib/optunaRunClosure.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const optunaRouter = fs.readFileSync('../ml-controller/routers/optuna.py', 'utf8')
const optunaJob = fs.readFileSync('../ml-controller/optuna_job_main.py', 'utf8')
const modalApp = fs.readFileSync('../ml-service/modal_app.py', 'utf8')
const modalClient = fs.readFileSync('../ml-controller/services/modal_client.py', 'utf8')

assert(
  workflows.includes("'/optuna/per_regime/run'"),
  'optuna queue must trigger per-regime through /optuna/per_regime/run, not the long synchronous route',
)
assert(
  workflows.includes('trigger_source: optunaTriggerSource(entry.reason)') &&
    workflows.includes('trigger_id: entry.id'),
  'optuna queue must forward trigger source and idempotency id to controller',
)
assert(
  workflows.includes('timeoutMs: isPerRegime ? 60_000 : 3_500_000'),
  'per-regime queue trigger must return quickly instead of waiting for robust search completion',
)
assert(
  workflows.includes('data.function_call_id') &&
    workflows.includes('data.run_id') &&
    workflows.includes('triggered_${executor}='),
  'optuna queue must treat Modal function_call_id/run_id as async trigger evidence',
)
assert(
  optunaQueue.includes('acquireOptunaQueueProcessorD1Lock') &&
    optunaQueue.includes('acquireOptunaRunD1Lock') &&
    optunaQueue.includes('INSERT INTO scheduler_locks') &&
    optunaQueue.includes('ON CONFLICT(lock_key) DO UPDATE') &&
    workflows.includes('acquireOptunaRunD1Lock(env.DB, entry') &&
    workflows.includes('d1_run_lock='),
  'optuna queue must use D1 scheduler_locks as a strong processor/run lock, not only KV get/put',
)
assert(
  optunaRunClosure.includes('closeOptunaQueueCallbackRun') &&
    optunaRunClosure.includes('closeOptunaRunD1Lock') &&
    optunaRunClosure.includes('recordSchedulerRunReportArtifact') &&
    adminControlRoutes.includes("String(body.task) === 'optuna-queue'") &&
    adminControlRoutes.includes('closeOptunaQueueCallbackRun') &&
    adminControlRoutes.includes('optuna_closure'),
  'optuna scheduler callback must close the D1 run lock and persist an artifact/readback payload',
)

assert(
  optunaRouter.includes('@router.post("/per_regime/run")') &&
    optunaRouter.includes('"OPTUNA_JOB_KIND": "per_regime"') &&
    optunaRouter.includes('"OPTUNA_TRIGGER_SOURCE"') &&
    optunaRouter.includes('"OPTUNA_TRIGGER_ID"') &&
    optunaRouter.includes('"OPTUNA_RUN_ID"'),
  'ml-controller must expose per-regime Job trigger with trigger ledger env',
)
assert(
  optunaJob.includes('OPTUNA_JOB_KIND') &&
    optunaJob.includes('OPTUNA_RUN_ID') &&
    optunaJob.includes('"metadata"') &&
    optunaJob.includes('"executor": "cloud_run_job"') &&
    optunaJob.includes('_build_per_regime_request') &&
    optunaJob.includes('run_per_regime'),
  'optuna Job entrypoint must execute per-regime mode from env',
)
assert(
  optunaRouter.includes('OPTUNA_PER_REGIME_EXECUTOR') &&
    optunaRouter.includes('spawn_optuna_per_regime') &&
    optunaRouter.includes('"executor": "cloud_run_job"'),
  'per-regime route must support env-gated Modal spawn while retaining Cloud Run Job fallback',
)
assert(
  modalApp.includes('_LOCAL_CONTROLLER_OPTUNA_DIR') &&
    modalApp.includes('_LOCAL_CONTROLLER_SERVICES_DIR') &&
    modalApp.includes('def optuna_per_regime_robust') &&
    modalApp.includes('_post_worker_scheduler_callback') &&
    modalApp.includes('/api/admin/scheduler-callback'),
  'Modal app must mount controller Optuna code, expose per-regime robust function, and callback Worker',
)
assert(
  modalClient.includes('"optuna_per_regime_robust"') &&
    modalClient.includes('async def spawn_optuna_per_regime') &&
    modalClient.includes('fn.spawn.aio(payload)') &&
    modalClient.includes('source="modal_spawn"'),
  'modal_client must expose a non-blocking per-regime Modal spawn helper with telemetry',
)
assert(
  modalApp.includes('"metadata": {') &&
    modalApp.includes('"executor": "modal"') &&
    modalApp.includes('"robust_sharpe": result.get("robust_sharpe")') &&
    optunaJob.includes('"robust_sharpe": result.get("robust_sharpe")'),
  'Modal and Cloud Run per-regime callbacks must include structured metadata for artifact readback',
)
