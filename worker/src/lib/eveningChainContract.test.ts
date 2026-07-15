const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const jobs = manifest.jobs as Array<{ id: string; task: string; schedule: string; query?: string }>

assert(
  jobs.some((job) => job.id === 'evening-chain' && job.task === 'evening-chain' && job.query === 'sync=1' && job.schedule === '0 13 * * 1-5'),
  'GCP Scheduler must keep one TW 21:00 evening-chain primary job for the post-market DAG',
)
assert(
  jobs.some((job) => job.id === 'market-close-refresh' && job.task === 'market-close-refresh' && job.query === 'sync=1' && job.schedule === '10 10 * * 1-5'),
  'GCP Scheduler must trigger TW 18:10 market-close-refresh before the 21:00 evening chain',
)
assert(
  jobs.some((job) => job.id === 'finlab-backfill-watchdog' && job.task === 'finlab-backfill-watchdog' && job.query === 'sync=1' && job.schedule === '*/10 13-15 * * 1-5'),
  'GCP Scheduler must run the FinLab pending watchdog after the evening-chain root',
)
assert(
  jobs.some((job) => job.id === 'allocator-ev-lifecycle-watchdog' && job.task === 'allocator-ev-lifecycle-watchdog' && job.query === 'sync=1' && job.schedule === '*/10 13-17 * * 1-5'),
  'GCP Scheduler must recover interrupted allocator EV daily lifecycle stages',
)
assert(
  jobs.some((job) => job.id === 'opb-arm-prior-refresh' && job.task === 'opb-arm-prior-refresh'
    && job.query === 'sync=1&expected_return_owner=auto' && job.schedule === '15 23 * * 6'),
  'GCP Scheduler must refresh OPB priors after weekly L4/Fusion owner refresh',
)
assert(
  jobs.some((job) => job.id === 'monthly-opb-arm-prior-refresh' && job.task === 'monthly-opb-arm-prior-refresh'
    && job.query === 'sync=1&expected_return_owner=auto'),
  'GCP Scheduler must include monthly OPB prior refresh with automatic production owner resolution',
)
assert(
  !jobs.some((job) => job.task === 'source-readiness-probe' || job.id.startsWith('source-readiness-probe')),
  'GCP Scheduler must not run source-readiness-probe jobs',
)

for (const removed of ['update', 'screener', 'pipeline', 'ml-warmup', 'adapt', 'daily-report', 'obsidian-sync', 'regime-compute', 'verify-v2']) {
  assert(
    !jobs.some((job) => job.id === removed),
    `${removed} must not remain as an independent fixed-time Scheduler job`,
  )
}

const workerTasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const gcpTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
assert(workerTasks.includes("'evening-chain'"), 'admin trigger map must expose evening-chain')
assert(workerTasks.includes("'market-close-refresh'"), 'admin trigger map must expose market-close-refresh')
assert(!workerTasks.includes("'source-readiness-probe'"), 'admin trigger map must not expose source-readiness-probe')
assert(
  gcpTasks.includes("'opb-arm-prior-refresh'") && gcpTasks.includes("'monthly-opb-arm-prior-refresh'"),
  'admin trigger map must expose weekly and monthly OPB prior refresh tasks',
)
assert(
  workerTasks.includes("'post-screener-pipeline'") &&
    workerTasks.includes('enqueuePostScreenerPipelineContinuation') &&
    workerTasks.includes("type: 'post_screener_pipeline'"),
  'admin trigger map must expose a minimal post-screener continuation repair without rerunning the full evening chain',
)

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const schedulerLockMigration = fs.readFileSync('migration_scheduler_locks.sql', 'utf8')
const runBulkFetchStart = updateOrchestrator.indexOf('export async function runBulkFetch')
const runBulkFetchEnd = updateOrchestrator.indexOf('export async function runQueueUpdate', runBulkFetchStart)
const runBulkFetchBody = updateOrchestrator.slice(runBulkFetchStart, runBulkFetchEnd)
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
  updateOrchestrator.includes('runMarketCloseRefresh') &&
    updateOrchestrator.includes('hasEveningChainSucceeded') &&
    updateOrchestrator.includes('21:00 root suppressed') &&
    !updateOrchestrator.includes('runSourceReadinessProbe'),
  'evening chain must run as the TW 21:00 primary root without the source-readiness probe backend/runtime path',
)
assert(
  updateOrchestrator.includes('runFinLabV4Backfill(env, twDate, force, {') &&
    updateOrchestrator.includes('continueEveningChain: true') &&
    updateOrchestrator.includes('dailySourceRefresh: true') &&
    updateOrchestrator.includes("callbackMode: 'evening_chain'") &&
    updateOrchestrator.includes("'finlab_backfill_complete'") &&
    updateOrchestrator.includes('assertFinLabCanonicalReadinessReady'),
  'evening-chain must refresh all FinLab daily source lanes first, then continue through queue callback only after full canonical readiness is verified',
)
assert(
  updateOrchestrator.includes('ensureTradingRestrictionsDailyReadiness') &&
    updateOrchestrator.includes("refreshOfficialTradingRestrictions(env, targetDate)") &&
    updateOrchestrator.includes('readiness.ok || isHistoricalReplayDate(targetDate)'),
  'current-day restriction fallback must refresh before downstream readiness while historical replay cannot use current official lists',
)
assert(
  updateOrchestrator.includes('runFinLabBackfillWatchdog') &&
    updateOrchestrator.includes('FINLAB_PENDING_WATCHDOG_STALE_MS') &&
    updateOrchestrator.includes('supersedeFunctionCallId') &&
    updateOrchestrator.includes('dispatchAttempt: nextAttempt'),
  'FinLab pending calls must be retriggered idempotently with the same run id and incremented dispatch attempt',
)
assert(
  updateOrchestrator.includes('watchdog dispatch reservation') &&
    updateOrchestrator.indexOf('watchdog dispatch reservation') < updateOrchestrator.indexOf('supersedeFunctionCallId: functionCallId'),
  'FinLab watchdog must reserve the next attempt before cancellation/spawn so stale callbacks are fenced',
)
assert(
  updateOrchestrator.includes('rowsOnTarget') &&
    updateOrchestrator.includes('stat.latestDate < targetDate') &&
    updateOrchestrator.includes('target_rows='),
  'historical evening-chain replay must validate target-date canonical rows instead of failing when a newer canonical date already exists',
)
assert(
  updateOrchestrator.includes('isHistoricalReplayDate') &&
    updateOrchestrator.includes('historical replay canonical already ready') &&
    updateOrchestrator.includes('historical replay skipped FinLab backfill'),
  'historical evening-chain replay must skip duplicate FinLab backfill when target-date canonical data is already ready',
)
assert(
  runBulkFetchBody.includes('TWSE/TPEX supplemental fetch skipped for historical replay') &&
    runBulkFetchBody.indexOf('TWSE/TPEX supplemental fetch skipped for historical replay') < runBulkFetchBody.indexOf('bulkFetchAndStorePrices'),
  'historical evening-chain replay must not refetch TWSE/TPEX supplemental data when target-date supplemental rows are already ready',
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
assert(
  updateOrchestrator.includes('repairFinalizeContinuationIfNeeded') &&
    updateOrchestrator.includes('hasSuccessfulScreenerRun') &&
    updateOrchestrator.includes('hasPipelineEvidence') &&
    updateOrchestrator.includes('stale-lock-repair'),
  'indicator queue finalizer must repair stale/orphaned locks so screener seed rows cannot strand the chain before pipeline',
)
assert(
  updateOrchestrator.includes("logSchedulerResult(env.KV, 'update'") &&
    updateOrchestrator.includes('market data update ready for'),
  'runDailyUpdate must write canonical update success logs so OBS can reconcile market-data readiness separately from downstream callbacks',
)
assert(
  updateOrchestrator.includes('event-driven chain reached pipeline trigger') &&
    updateOrchestrator.includes("status: 'triggered'"),
  'pipeline trigger must keep evening-chain in triggered state until callback closure writes final root-chain success',
)
assert(
  updateOrchestrator.includes('runDailyAllocatorEvReadiness') &&
    updateOrchestrator.includes('runL4AlphaEvRefresh') &&
    updateOrchestrator.includes('runAllocatorEvFusionRefresh') &&
    updateOrchestrator.includes('runOpbArmPriorRefresh') &&
    updateOrchestrator.indexOf('const evReadiness = await runDailyAllocatorEvReadiness') <
      updateOrchestrator.indexOf('const summary = await deps.runMLAndRiskV2'),
  'evening-chain must refresh L4/fusion model readiness before triggering pipeline',
)
assert(
  updateOrchestrator.includes("logSchedulerResult(env.KV, 'allocator-ev-fusion-refresh'") &&
    updateOrchestrator.includes('fusion_degraded=') &&
    updateOrchestrator.includes('pipeline continues with validated L4 alpha EV or S12 trade EV') &&
    updateOrchestrator.includes('BUY/allocation remain fail closed when expected return is unavailable'),
  'allocator EV fusion validation failure must remain visible while expected-return action gates stay fail closed',
)
assert(
  updateOrchestrator.includes('l4_challenger_rejected=') &&
    updateOrchestrator.includes('l4_champion_retained=') &&
    updateOrchestrator.includes('l4_unavailable=') &&
    updateOrchestrator.includes('expected_return_action_gate=validated_s12_only') &&
    updateOrchestrator.includes("champion.promotion_state === 'production_approved'") &&
    updateOrchestrator.includes("championDecision === 'PASS'"),
  'L4 readiness must retain a compatible champion or continue observation with BUY/allocation fail closed',
)
assert(
  updateOrchestrator.includes('analysis_continues=1 execution_fail_closed=1') &&
    updateOrchestrator.includes('snapshotComplete && snapshotSummary.skipped === 0'),
  'missing S12 bars must remain an observable scheduler error while analysis continues under fail-closed execution gates',
)

const mlPipelineTrigger = fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')
const marketDataReadiness = fs.readFileSync('src/lib/marketDataReadiness.ts', 'utf8')
assert(
  marketDataReadiness.includes('targetAwareTableStats') &&
    marketDataReadiness.includes("targetAwareTableStats(db, 'stock_prices', targetDate)") &&
    marketDataReadiness.includes('if (targetRows > 0) return { latestDate: targetDate'),
  'market-data readiness must evaluate target-date rows for historical replay instead of only MAX(date)',
)
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
  mlPipelineTrigger.includes('prevalidatedEventChain') &&
    mlPipelineTrigger.includes('assertMarketDataReady(env.DB, twDate)') &&
    updateOrchestrator.includes('prevalidatedEventChain: true'),
  'event-driven post-screener pipeline trigger must not depend on KV scheduler telemetry after the chain has already validated indicator/screener/regime stages',
)
assert(
  mlPipelineTrigger.includes('active execution') && mlPipelineTrigger.includes('return `LOCKED active execution'),
  'ml-controller 409 active execution must be treated as LOCKED/triggered, not a false evening-chain error',
)
assert(
  mlPipelineTrigger.includes('market risk unavailable; pipeline blocked') &&
    !mlPipelineTrigger.includes('Market risk failed (non-blocking)'),
  'pipeline trigger must fail closed when market risk cannot be computed',
)

const callbackRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
assert(
  callbackRoutes.includes('const forceContinuation = Boolean') &&
    callbackRoutes.includes('force: forceContinuation'),
  'FinLab callback must preserve manual force rerun through the async queue continuation',
)
assert(
  callbackRoutes.includes("type: 'post_pipeline_chain'") &&
    callbackRoutes.includes('callback:post-pipeline-enqueued:'),
  'pipeline callback must durably queue post-market dependent tasks instead of fixed-time Scheduler jobs',
)
assert(
  callbackRoutes.includes("type: 'post_verify_chain'") &&
    callbackRoutes.includes('callback:post-verify-enqueued:'),
  'verify callback must durably queue IC/adapt/report/obsidian instead of fixed-time Scheduler jobs',
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
