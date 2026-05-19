const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const jobs = manifest.jobs as Array<{ id: string; task: string; schedule: string; query?: string }>

assert(
  jobs.some((job) => job.id === 'evening-chain' && job.task === 'evening-chain' && job.query === 'sync=1' && job.schedule === '0 14 * * 1-5'),
  'GCP Scheduler must trigger one TW 22:00 evening-chain root job for the post-market DAG',
)

for (const removed of ['update', 'screener', 'pipeline', 'ml-warmup', 'adapt', 'daily-report', 'obsidian-sync', 'regime-compute', 'verify-v2']) {
  assert(
    !jobs.some((job) => job.id === removed),
    `${removed} must not remain as an independent fixed-time Scheduler job`,
  )
}

const workerTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
assert(workerTasks.includes("'evening-chain'"), 'admin trigger map must expose evening-chain')

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const schedulerLockMigration = fs.readFileSync('migration_scheduler_locks.sql', 'utf8')
assert(updateOrchestrator.includes('indicator-queue'), 'indicator queue must have scheduler-visible run state')
assert(updateOrchestrator.includes('UPDATE_SHARD_COUNT'), 'indicator queue must fan out into shards instead of one serial cursor')
assert(updateOrchestrator.includes('sendBatch'), 'indicator queue root trigger must enqueue shard messages as a real batch')
assert(updateOrchestrator.includes('markShardComplete'), 'indicator queue must wait for all shards before starting screener/pipeline')
assert(
  updateOrchestrator.includes('acquireFinalizeLock') &&
    updateOrchestrator.includes('INSERT OR IGNORE INTO scheduler_locks'),
  'indicator queue finalizer must use an atomic D1 lock; KV get/put is not safe for concurrent finalizers',
)
assert(
  schedulerLockMigration.includes('CREATE TABLE IF NOT EXISTS scheduler_locks') &&
    schedulerLockMigration.includes('lock_key   TEXT PRIMARY KEY'),
  'scheduler_locks migration must exist before the atomic finalizer lock is deployed',
)
assert(
  updateOrchestrator.includes("'source_readiness_retry'") &&
    updateOrchestrator.includes('SOURCE_READINESS_RETRY_DELAY_SECONDS') &&
    updateOrchestrator.includes('source waiting'),
  'evening-chain must defer/retry same-day source readiness instead of fail-closing immediately at the scheduled root time',
)
assert(
  updateOrchestrator.includes('runQueueUpdate(env, twDate, force)'),
  'force rerun must bypass the queue-update lock, not only the bulk-fetch lock',
)
assert(updateOrchestrator.includes('runMarketScreener'), 'evening chain must run screener after indicator readiness')
assert(
  updateOrchestrator.indexOf('runMarketScreener') < updateOrchestrator.indexOf('runMLAndRiskV2'),
  'evening chain must run screener before pipeline/ML',
)
assert(
  updateOrchestrator.includes('pipeline already running for') &&
    updateOrchestrator.includes("status: 'triggered'"),
  'evening chain must not overwrite a successful in-flight pipeline trigger with success/LOCKED telemetry',
)

const mlPipelineTrigger = fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')
assert(
  mlPipelineTrigger.includes('assertEveningPipelineReady'),
  'pipeline trigger must require evening-chain readiness before calling ml-controller',
)
assert(
  mlPipelineTrigger.includes('indicator queue not complete'),
  'pipeline readiness must block direct triggers until indicator queue completes',
)
assert(
  mlPipelineTrigger.includes('regime-compute not complete'),
  'pipeline readiness must block direct triggers until same-date regime-compute writes market_regime_state',
)
assert(
  mlPipelineTrigger.includes('active execution') && mlPipelineTrigger.includes('return `LOCKED active execution'),
  'ml-controller 409 active execution must be treated as LOCKED/triggered, not a false evening-chain error',
)

const callbackRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
assert(
  callbackRoutes.includes('runPostPipelineCallbackChain'),
  'pipeline callback must advance post-market dependent tasks instead of fixed-time Scheduler jobs',
)
assert(
  callbackRoutes.includes('runPostVerifyCallbackChain'),
  'verify callback must advance IC/adapt/report/obsidian instead of fixed-time Scheduler jobs',
)

const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
assert(
  postMarketChain.includes('runVerifyV2(env, ctx.runDate)'),
  'post-pipeline chain must trigger verify-v2 with the callback business date',
)
assert(
  postMarketChain.indexOf("'model-ic-tracker', () => runModelIcRollingRefresh") <
    postMarketChain.indexOf("'adapt', () => runAdaptiveUpdate"),
  'post-verify chain must refresh rolling IC before adaptive params',
)
