const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const jobs = manifest.jobs as Array<{ id: string; task: string; schedule: string; query?: string }>
const walkForward = fs.readFileSync('../ml-controller/routers/walk_forward.py', 'utf8')

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
  !jobs.some((job) => job.id === 'opb-arm-prior-refresh' || job.id === 'monthly-opb-arm-prior-refresh'),
  'fixed-time OPB refresh must not race OOF quality/parity promotion',
)
assert(
  walkForward.includes('/api/admin/trigger/opb-arm-prior-refresh') &&
    walkForward.indexOf('promoted = True') < walkForward.indexOf('/api/admin/trigger/opb-arm-prior-refresh'),
  'OPB priors must refresh event-driven only after OOF L4/Fusion promotion succeeds',
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
const postScreenerContinuation = fs.readFileSync('src/lib/postScreenerContinuation.ts', 'utf8')
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
    postScreenerContinuation.includes("type: 'post_screener_pipeline'"),
  'admin trigger map must expose a minimal post-screener continuation repair without rerunning the full evening chain',
)

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert(
  updateOrchestrator.includes('const current = await loadFinalizeLock') &&
    updateOrchestrator.includes('current?.owner === leaseOwner'),
  'finalizer lease renewal must verify the durable owner before treating D1 zero-change metadata as lease loss',
)
const expectedReturnServingState = fs.readFileSync('src/lib/expectedReturnServingState.ts', 'utf8')
const decisionOwnerContract = fs.readFileSync('src/lib/decisionOwnerContract.ts', 'utf8')
const controllerDailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
assert(
  updateOrchestrator.includes('refreshMatureStrategyEvidenceBeforeScreener') &&
    updateOrchestrator.indexOf('const matureStrategyEvidence = await refreshMatureStrategyEvidenceBeforeScreener') <
      updateOrchestrator.indexOf('const runAsyncScreener = deps.runMarketScreenerAsync'),
  'mature strategy labels/edge/rewards must refresh fail-closed before the current-day screener consumes priors',
)
assert(
  controllerDailyWorkflows.includes('restoreMarketRegimeStateFromHistory') &&
    controllerDailyWorkflows.includes('immutable_market_d1_history') &&
    controllerDailyWorkflows.includes('assertRegimeComputeClosure(data, runDate)') &&
    controllerDailyWorkflows.includes('readMarketRegimeState(env.KV)') &&
    controllerDailyWorkflows.includes('market_regime_state readback mismatch'),
  'regime compute must verify same-date KV persistence and posterior surface before downstream stages',
)
assert(
  controllerDailyWorkflows.includes('Controller /obsidian/daily HTTP ${res.status}') &&
    !controllerDailyWorkflows.includes('return res.ok ? await res.json()'),
  'obsidian sync must classify non-2xx controller responses as scheduler errors',
)
assert(updateOrchestrator.includes('refreshExpectedReturnServingState'), 'daily readiness must persist canonical expected-return serving state')
assert(expectedReturnServingState.includes("'retired_incompatible'"), 'stale promoted artifacts must be explicitly retired from serving without rewriting evidence')
assert(decisionOwnerContract.includes("'selection_signal_owner'"), 'no-EV-owner production behavior must retain formal Score V2 allocation utility')
assert(decisionOwnerContract.includes("'recommendation_allocation_only_no_order_submission'"), 'selection utility continuity must never imply order submission authority')
assert(!decisionOwnerContract.includes("'canonical_l4_required'"), 'L4 challenger maturity must not remain a global recommendation veto')
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
    updateOrchestrator.includes('ON CONFLICT(lock_key) DO UPDATE SET') &&
    updateOrchestrator.includes('assertFinalizeLockRenewed'),
  'indicator queue finalizer must use an atomic D1 lock; KV get/put is not safe for concurrent finalizers',
)
assert(
  schedulerLockMigration.includes('CREATE TABLE IF NOT EXISTS scheduler_locks') &&
    schedulerLockMigration.includes('lock_key   TEXT PRIMARY KEY'),
  'scheduler_locks migration must exist before the atomic finalizer lock is deployed',
)
const sourceRetryStart = updateOrchestrator.indexOf("if (msg.type === 'source_readiness_retry')")
const sourceRetryEnd = updateOrchestrator.indexOf("if (msg.type === 'news_batch')", sourceRetryStart)
const sourceRetryBody = updateOrchestrator.slice(sourceRetryStart, sourceRetryEnd)
assert(
  updateOrchestrator.includes("'source_readiness_retry'") &&
    updateOrchestrator.includes('SOURCE_READINESS_RETRY_DELAY_SECONDS') &&
    updateOrchestrator.includes('source waiting') &&
    sourceRetryBody.includes('refreshOfficialMarketSummaryIfMissing(env, triggerTime, Date.now())') &&
    sourceRetryBody.indexOf('refreshOfficialMarketSummaryIfMissing') < sourceRetryBody.indexOf('checkEveningChainSourceReadiness'),
  'evening-chain retry must refresh same-day official market summary before rechecking source readiness',
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
  updateOrchestrator.includes('retriablePartialFailure') &&
    updateOrchestrator.includes('/partial_failed/i') &&
    updateOrchestrator.includes('allowFetchedLaneRefetch: retriablePartialFailure') &&
    updateOrchestrator.includes("retriablePartialFailure ? 'partial failure' : 'pending dispatch'"),
  'FinLab watchdog must retry source-key-scoped partial failures, including incomplete keys inside a fetched lane',
)
assert(
  updateOrchestrator.includes('FinLab watchdog found no source keys eligible for refetch'),
  'FinLab watchdog must not turn an empty repair scope into an accidental all-lane refetch',
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
    updateOrchestrator.includes('expired-lease-repair'),
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
    updateOrchestrator.includes('inspectExpectedReturnLifecycleHealth') &&
    !updateOrchestrator.includes('runL4AlphaEvRefresh') &&
    !updateOrchestrator.includes('runAllocatorEvFusionRefresh') &&
    updateOrchestrator.includes('runOpbArmPriorRefresh') &&
    updateOrchestrator.indexOf('const evReadiness = await runDailyAllocatorEvReadiness') <
      updateOrchestrator.indexOf('const summary = await deps.runMLAndRiskV2'),
  'evening-chain must inspect pointer-backed L4/Fusion readiness before triggering pipeline',
)
assert(
  updateOrchestrator.includes("logSchedulerResult(env.KV, 'allocator-ev-readiness'") &&
    updateOrchestrator.includes("status: state === 'fatal' ? 'error' : 'success'") &&
    updateOrchestrator.includes('no_validated_expected_return_lane'),
  'Fusion readiness failure must remain visible and fail BUY/allocation closed',
)
const allocatorReadinessGuardStart = updateOrchestrator.indexOf('if (!evReadiness.ok)')
const pipelineTriggerStart = updateOrchestrator.indexOf('const summary = await deps.runMLAndRiskV2', allocatorReadinessGuardStart)
const allocatorReadinessGuardBody = updateOrchestrator.slice(allocatorReadinessGuardStart, pipelineTriggerStart)
assert(
  allocatorReadinessGuardStart >= 0 &&
    pipelineTriggerStart > allocatorReadinessGuardStart &&
    allocatorReadinessGuardBody.includes('BUY/allocation remains fail-closed while the evidence-only pipeline continues') &&
    !allocatorReadinessGuardBody.includes('\n    return\n'),
  'missing Fusion must preserve explicit risk abstention while allowing ML/recommendation evidence to continue',
)
assert(
  updateOrchestrator.includes('refreshExpectedReturnServingState') &&
    expectedReturnServingState.includes("artifact.promotion_state !== requiredPromotionState") &&
    expectedReturnServingState.includes("String(artifact.validation_packet?.decision ?? '').toUpperCase() !== 'PASS'") &&
    expectedReturnServingState.includes('resolveDecisionOwnerContract(owner)') &&
    expectedReturnServingState.includes('hydrateExpectedReturnConfigFromPointers'),
  'D1 champion pointers must remain source of truth while canonical L4 owns base expected return and strict Fusion is an optional residual overlay',
)
assert(
  updateOrchestrator.includes('Deprecated S12 candidate snapshot message drained without serving side effects') &&
    updateOrchestrator.includes("msg.type === 's12_replay_backfill_chunk'") &&
    !updateOrchestrator.includes("type: 's12_candidate_snapshot_chunk'"),
  'production evening S12 candidate snapshots must be removed while mature historical replay labels remain available',
)

const mlPipelineTrigger = fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')
const marketDataReadiness = fs.readFileSync('src/lib/marketDataReadiness.ts', 'utf8')
assert(
  marketDataReadiness.includes('targetAwareTableStats') &&
    marketDataReadiness.includes("targetAwareTableStats(marketDb, 'stock_prices', targetDate)") &&
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
    mlPipelineTrigger.includes('assertMarketDataReady(env, twDate)') &&
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
const pipelineStageLease = fs.readFileSync('src/lib/pipelineStageLease.ts', 'utf8')
assert(
  callbackRoutes.includes('const forceContinuation = Boolean') &&
    callbackRoutes.includes('force: forceContinuation'),
  'FinLab callback must preserve manual force rerun through the async queue continuation',
)
assert(
  callbackRoutes.includes('queuePostPipelineStage') &&
    pipelineStageLease.includes("stage: 'post_pipeline_chain'"),
  'pipeline callback must durably queue one date-level post-market stage instead of fixed-time Scheduler jobs',
)
assert(
  callbackRoutes.includes('queuePostVerifyStage') &&
    pipelineStageLease.includes("stage: 'post_verify_chain'"),
  'verify callback must durably queue IC/adapt/report/obsidian through the date-level D1 stage owner',
)

const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
assert(
  postMarketChain.includes('`verify_v2:${ctx.runDate}:${snapshotEvidenceKey}`'),
  'post-pipeline chain must trigger verify-v2 with a deterministic date-level idempotency key',
)
assert(
  postMarketChain.indexOf("'model-ic-rolling', () => runModelIcRollingRefresh") <
    postMarketChain.indexOf("'adapt', () => runAdaptiveUpdate"),
  'post-verify chain must refresh rolling IC before adaptive params',
)
