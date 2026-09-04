import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const callbackRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const pipelineStageLease = fs.readFileSync('src/lib/pipelineStageLease.ts', 'utf8')
const mlPipelineTrigger = fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')
const postScreenerContinuation = fs.readFileSync('src/lib/postScreenerContinuation.ts', 'utf8')
const researchWorkflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const strategyLearning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const adminTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const controllerDailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
const allocatorCallbackMarker = callbackRoutes.indexOf("body.task === 'allocator-ev-feature-snapshot-backfill'")
const pipelineCallbackMarker = callbackRoutes.indexOf("if (body.task === 'pipeline'", allocatorCallbackMarker)
const pipelineCallbackBlock = callbackRoutes.slice(
  pipelineCallbackMarker,
  callbackRoutes.indexOf("const verifyCanContinue", pipelineCallbackMarker),
)
const verifyCallbackBlock = callbackRoutes.slice(
  callbackRoutes.indexOf("const verifyCanContinue"),
  callbackRoutes.indexOf("if (body.task === 'verify-v2' && String(body.status) === 'error')"),
)
const allocatorSnapshotCallbackBlock = callbackRoutes.slice(
  allocatorCallbackMarker,
  pipelineCallbackMarker,
)
const postScreenerContinuationBlock = updateOrchestrator.slice(
  updateOrchestrator.indexOf('async function continuePostScreenerPipeline'),
  updateOrchestrator.indexOf('async function markShardComplete'),
)
const postVerifyQueueBlock = updateOrchestrator.slice(
  updateOrchestrator.indexOf("if (msg.type === 'post_verify_chain')"),
  updateOrchestrator.indexOf("if (msg.type === 'allocator_ev_lifecycle_recovery')"),
)
const metaShadowBlock = postMarketChain.slice(
  postMarketChain.indexOf("'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask"),
  postMarketChain.indexOf("'strategy-learning', () => enqueueStrategyLearningClosureTask"),
)
const metaShadowClosureBlock = postMarketChain.slice(
  postMarketChain.indexOf('async function runMetaLearningShadowClosure'),
  postMarketChain.indexOf('async function enqueueStrategyLearningClosureTask'),
)
const evidenceOnlySnapshotBlock = postMarketChain.slice(
  postMarketChain.indexOf('let snapshotTask: ChainedTask'),
  postMarketChain.indexOf('results.push(snapshotTask)'),
)

assert(callbackRoutes.includes("body.task === 'pipeline'"), 'pipeline callback must be explicitly handled')
assert(
  callbackRoutes.includes('const authError = await requireServiceToken(c)'),
  'scheduler callback must await service-token auth before evaluating the result',
)
assert(
  controllerDailyWorkflows.includes('verify-v2 already has an active execution') &&
    controllerDailyWorkflows.includes('verify_v2_active_execution_conflict') &&
    controllerDailyWorkflows.includes('retry_required'),
  'an unproven active verify execution must fail closed for bounded retry instead of waiting for a nonexistent callback',
)
assert(
  adminTasks.includes('runVerifyV2Repair') &&
    controllerDailyWorkflows.includes("stage: 'verify_v2'") &&
    controllerDailyWorkflows.includes('expectedVerifyProducerRunId') &&
    controllerDailyWorkflows.includes('verify-repair:') &&
    controllerDailyWorkflows.includes("status: 'waiting'") &&
    controllerDailyWorkflows.includes('callbackWonRace'),
  'direct verify repair must establish a canonical producer cursor before dispatch and preserve callback-race idempotency',
)
assert(callbackRoutes.includes('lock:ml-predict'), 'pipeline terminal callback must clear the ML predict lock')
assert(
  callbackRoutes.includes('queuePostPipelineStage') &&
    pipelineStageLease.includes('INSERT INTO pipeline_stage_runs') &&
    pipelineStageLease.includes("stage: 'post_pipeline_chain'"),
  'pipeline and snapshot callbacks must share the durable date-level post-pipeline stage',
)
assert(
  pipelineStageLease.includes('expectedCanonicalRunId') &&
    allocatorSnapshotCallbackBlock.includes('expectedCanonicalRunId: callbackRunId') &&
    !allocatorSnapshotCallbackBlock.includes('supersedeSuccess: true'),
  'allocator snapshot callbacks must atomically resume only their exact canonical stage and never supersede success',
)
assert(
  pipelineCallbackBlock.includes("stage: 'pipeline_execution'") &&
    pipelineCallbackBlock.includes("status: 'success'") &&
    !pipelineCallbackBlock.includes('adoptRunIdOnResume') &&
    verifyCallbackBlock.includes('cursorKey: callbackRunId') &&
    verifyCallbackBlock.includes('authority: {'),
  'pipeline continuation must be owned by exact D1 dispatch authority while verify uses producer cursor plus D1 authority',
)
assert(
  pipelineStageLease.includes('FROM strategy_learning_runs strategy_learning')
    && pipelineStageLease.includes("strategy_learning.status IN ('running', 'success')")
    && pipelineStageLease.includes('strategy_learning.lease_expires_at >= CURRENT_TIMESTAMP'),
  'post-verify canonical takeover must preserve a live strategy-learning lease owned by the prior canonical run',
)
assert(
  callbackRoutes.includes('queuePostVerifyStage') &&
    pipelineStageLease.includes("stage: 'post_verify_chain'"),
  'verify terminal callback must durably and idempotently queue the post-verify chain',
)
assert(
  postMarketChain.includes('verify_v2:${ctx.runDate}:${snapshotEvidenceKey}'),
  'verify idempotency must change with snapshot evidence while duplicate callbacks for the same snapshot remain stable',
)
assert(
  callbackRoutes.includes("['success', 'skipped'].includes(String(body.status))"),
  'verify-v2 skipped callback must continue post-verify chain for replay dates with no matured prediction window',
)
assert(
  !pipelineCallbackBlock.includes('executionCtx.waitUntil'),
  'pipeline terminal callback must use the durable queue instead of waitUntil for post-pipeline closure',
)
assert(
  !verifyCallbackBlock.includes('executionCtx.waitUntil') &&
    verifyCallbackBlock.includes('queuePostVerifyStage'),
  'verify terminal callback must use the durable D1-owned queue instead of a bounded waitUntil continuation',
)

assert(
  postMarketChain.includes('maxProcessDates: 8') &&
    postMarketChain.includes('post_verify_chain_failed:price-horizon-projection:') &&
    postMarketChain.includes('post_verify_chain_failed:strategy-evidence-current:') &&
    updateOrchestrator.includes('post_verify_chain_returned_error_without_detail'),
  'post-verify critical tasks must throw into durable stage last_error and can never finalize an error return as success',
)
assert(
  postMarketChain.includes('const productionEligible = productionAuthority.allowed'),
  'production-only tasks must use resolved canonical authority so historical reruns cannot dirty current reports',
)
assert(
  postMarketChain.includes('verify_v2:${ctx.runDate}:${snapshotEvidenceKey}') &&
    postMarketChain.includes("stage: 'verify_v2'"),
  'verify-v2 must receive the callback business date and deterministic snapshot-owned idempotency key',
)
assert(
  postMarketChain.includes('runAllocatorEvFeatureSnapshotBackfill') &&
    postMarketChain.indexOf("'allocator-ev-feature-snapshot-backfill'") <
      postMarketChain.indexOf("'verify-v2'"),
  'same-date allocator feature snapshots must be materialized after pipeline output and before verify',
)
assert(
  postMarketChain.includes("snapshotTask.status === 'error' || (!snapshotUnavailableInEvidenceOnlyMode && !snapshotClosure.ready)") &&
    postMarketChain.includes("await logChainSummary(env, ctx, 'post-pipeline-chain'"),
  'post-pipeline chain must stop before verify when canonical allocator snapshots are missing',
)
assert(
  postMarketChain.includes('inspectActive8ActionAuthorityState') &&
    postMarketChain.includes('active8_serving_pointer_integrity_invalid') &&
    postMarketChain.includes('active8_evidence_only_action_leak') &&
    postMarketChain.includes("task: 'active8-action-authority'") &&
    postMarketChain.includes('actionable=0 production_effect=0') &&
    postMarketChain.includes("'active8-evidence-only-authority-v1'") &&
    evidenceOnlySnapshotBlock.includes('emitChainedTaskObservability(') &&
    evidenceOnlySnapshotBlock.includes("'skipped'") &&
    evidenceOnlySnapshotBlock.includes('{ supersedePrevious: true }') &&
    evidenceOnlySnapshotBlock.includes('critical: false') &&
    postMarketChain.includes('if (!snapshotUnavailableInEvidenceOnlyMode) {'),
  'evidence-only continuation must require an exact zero-action authority attestation and preserve pointer integrity fail-closed',
)
assert(
  pipelineStageLease.includes('attempt_count') &&
    pipelineStageLease.includes('input.attempt ?? state.row.attempt_count') &&
    updateOrchestrator.match(/recoveryAttempt: Math\.max\(0, Number\(msg\.attempt \?\? 0\)\)/g)?.length === 2 &&
    !updateOrchestrator.includes('Number(claimed.attempt_count ?? 1) - 1') &&
    postMarketChain.includes('allocator snapshot retry budget exhausted'),
  'allocator snapshot retries must use the durable message attempt and ignore generic stage claims',
)
assert(
  postMarketChain.includes('attempt_id: resolveChainAttemptId(ctx)') &&
    updateOrchestrator.match(/recoveryAttempt: Math\.max\(/g)?.length === 2,
  'post-pipeline and post-verify retries must emit attempt-scoped scheduler evidence so recovery can replace an earlier error',
)
assert(
  researchWorkflows.includes('durable: !(params.dryRun ?? false)') &&
    researchWorkflows.includes('upstream_run_id: params.runId') &&
    postMarketChain.includes("/\\bstatus=(?:spawned|pending)\\b/i") &&
    callbackRoutes.includes("body.task === 'allocator-ev-feature-snapshot-backfill'") &&
    callbackRoutes.includes('resumeWaiting: true'),
  'allocator snapshots must use a durable job and resume the same date-level post-pipeline stage from its callback',
)
assert(
  postScreenerContinuationBlock.indexOf('ensureSameDateRegimeReady(env, triggerTime') > 0 &&
    postScreenerContinuationBlock.indexOf('ensureSameDateRegimeReady(env, triggerTime') <
      postScreenerContinuationBlock.indexOf('deps.runMLAndRiskV2(env, triggerTime'),
  'post-screener continuation must retain a same-date regime assertion before pipeline/recommendation',
)
assert(
  postScreenerContinuation.includes("type: 'post_screener_pipeline'") &&
    updateOrchestrator.includes("if (msg.type === 'post_screener_pipeline')") &&
    updateOrchestrator.includes('continuePostScreenerPipeline(env, deps, triggerTime, runId)'),
  'indicator-queue finalization must enqueue and consume post-screener continuation instead of requiring manual pipeline trigger',
)
const postScreenerPipelineCatch = postScreenerContinuationBlock.slice(
  postScreenerContinuationBlock.indexOf("summary: `event-driven chain stopped: pipeline trigger failed"),
  postScreenerContinuationBlock.indexOf('\n  }\n}', postScreenerContinuationBlock.indexOf("summary: `event-driven chain stopped: pipeline trigger failed")),
)
assert(
  postScreenerPipelineCatch.includes("console.warn('[Queue] Event-driven ML trigger failed:', e)") &&
    postScreenerPipelineCatch.includes('throw e'),
  'post-screener continuation must fail closed when pipeline dispatch fails so its durable stage ticket cannot report false success',
)
assert(
  !postMarketChain.includes("runRegimeCompute(env)"),
  'post-pipeline chain must not be the primary regime producer; pipeline already consumed market_regime_state by then',
)
assert(
  postMarketChain.includes('runModelIcRollingRefresh(env, ctx.runDate)'),
  'rolling IC refresh must receive the callback business date',
)
assert(
  postMarketChain.includes("type: 's12_replay_backfill_chunk'") &&
    postMarketChain.includes("'s12-replay-backfill', () => enqueueS12ReplayBackfillTask") &&
    postMarketChain.includes('statusRunDate: runDate') &&
    updateOrchestrator.includes('run_date: statusRunDate'),
  'post-verify chain must enqueue S12 replay backfill after daily recommendations are available',
)
assert(
  strategyLearning.includes('limit + 1, afterSymbol') &&
    strategyLearning.includes('listStrategyLearningCandidates(options.candidateDb ?? db, options.date, limit + 1, afterSymbol)') &&
    strategyLearning.includes('const hasMore = candidatePage.length > limit') &&
    strategyLearning.includes('const candidates = candidatePage.slice(0, limit)') &&
    strategyLearning.includes('next_cursor_symbol: nextCursorSymbol') &&
    strategyLearning.includes('has_more: hasMore'),
  'strategy-learning must combine limit+1 lookahead with a stable symbol keyset cursor',
)
assert(
  postMarketChain.indexOf("runPostPipelineCallbackChain") < postMarketChain.indexOf("runPostVerifyCallbackChain"),
  'post-pipeline and post-verify chains must stay separate owners',
)
assert(
  postMarketChain.indexOf("'model-ic-rolling', () => runModelIcRollingRefresh") <
    postMarketChain.indexOf("'s12-replay-backfill', () => enqueueS12ReplayBackfillTask") &&
    postMarketChain.indexOf("'s12-replay-backfill', () => enqueueS12ReplayBackfillTask") <
    postMarketChain.indexOf("'paper-intraday-cache-clear', () => clearOpenPositionIntradayPriceCache"),
  'post-verify chain must enqueue S12 replay after model IC and before current-date report tasks',
)
assert(
  postMarketChain.indexOf("'paper-intraday-cache-clear', () => clearOpenPositionIntradayPriceCache") <
    postMarketChain.indexOf("'linucb-reward-ledger', () => runLinUcbRewardLedgerRefresh"),
  'LinUCB reward ledger must run after rolling IC evidence refresh',
)
assert(
  postMarketChain.indexOf("'linucb-reward-ledger', () => runLinUcbRewardLedgerRefresh") <
    postMarketChain.indexOf("'adapt', () => runAdaptiveUpdate"),
  'adaptive params must run after LinUCB reward ledger is refreshed',
)
assert(
  postMarketChain.indexOf("'obsidian-sync', () => runObsidianDaily") <
    postMarketChain.indexOf("'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask"),
  'Neural meta-learning shadow evidence must not block adaptive params, report, or obsidian sync',
)
assert(
  postMarketChain.indexOf("'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask") <
    postMarketChain.indexOf("'strategy-learning', () => enqueueStrategyLearningClosureTask"),
  'Meta-learning evidence must be durably enqueued before strategy-learning closure',
)
assert(
  !postMarketChain.includes("logSkippedHistoricalTask(env, ctx, 'strategy-learning')"),
  'Strategy learning must run for historical reruns so strategy_decision_log can materialize replay-date family evidence',
)
assert(
  postMarketChain.includes('resolveEveningChainRunAuthority'),
  'post-verify must resolve production authority from durable canonical stage identity',
)
assert(
  postMarketChain.includes('force: productionEligible'),
  'queued learning tasks must preserve durable live-canonical eligibility across midnight',
)
assert(
  postMarketChain.includes("type: 'strategy_learning_materialize'") &&
    postMarketChain.includes('waiting for queued strategy-learning'),
  'post-verify must enqueue strategy-learning materialization and keep root chain running until queue closure writes final status',
)
assert(
  postMarketChain.includes('runPaperActivePostmarketPromotion'),
  'post-verify chain must include paper-active postmarket promotion closure',
)
assert(
  postMarketChain.indexOf("'daily-report', () => generateDailyReport") <
    postMarketChain.indexOf("'paper-active-postmarket', () => runPaperActivePostmarketPromotion"),
  'paper-active postmarket promotion should run after daily report source metrics are available',
)
assert(
  postMarketChain.indexOf("'paper-active-postmarket', () => runPaperActivePostmarketPromotion") <
    postMarketChain.indexOf("'obsidian-sync', () => runObsidianDaily"),
  'paper-active postmarket summary should be available before obsidian sync',
)
assert(
  postMarketChain.includes("{ critical: false }"),
  'Neural meta-learning shadow evidence must be non-critical for the production post-verify closure',
)
assert(
  metaShadowBlock.includes("'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask") &&
    metaShadowBlock.includes('timeoutMs: TASK_EXECUTION_TIMEOUT_MS'),
  'Neural meta-learning shadow enqueue must be timeout-bounded so it cannot leave post-verify/evening-chain triggered',
)
assert(
  postMarketChain.includes("type: 'meta_learning_shadow_closure'") &&
    updateOrchestrator.includes("if (msg.type === 'meta_learning_shadow_closure')"),
  'Neural meta-learning shadow must run as a durable queue continuation with final scheduler status',
)
assert(
  postMarketChain.includes("'ga-shadow-daily', () => enqueueGaOptimizerShadowClosureTask") &&
    postMarketChain.includes("type: 'ga_optimizer_shadow_closure'") &&
    updateOrchestrator.includes("if (msg.type === 'ga_optimizer_shadow_closure')") &&
    updateOrchestrator.includes('ensureLatestGaShadowEnrolled'),
  'GA frozen shadow must run as a durable post-verify queue continuation',
)
assert(
  updateOrchestrator.includes('ga_shadow_daily_requires_production_authority_intent') &&
    updateOrchestrator.includes('ga_shadow_daily_production_authority_denied') &&
    updateOrchestrator.includes('resolveEveningChainRunAuthority'),
  'GA shadow queue finalizer must reject historical/non-canonical evidence accumulation',
)
assert(
  researchWorkflows.includes("'/optuna/ga_shadow/daily/run'") &&
    researchWorkflows.includes('remote_execution_id=${remote.remoteExecutionId}') &&
    callbackRoutes.includes("body.task === 'ga-shadow-daily'") &&
    callbackRoutes.includes('refreshActiveGaShadowProjection') &&
    callbackRoutes.includes('ga_shadow_projection_readback_failed'),
  'GA shadow must have async Cloud Run dispatch and retryable terminal projection closure',
)
assert(
  metaShadowClosureBlock.includes('const sourceRows = await listLinUcbRewardSourceRows') &&
    metaShadowClosureBlock.includes('Promise.all([') &&
    metaShadowClosureBlock.match(/sourceRows,/g)?.length === 3,
  'Neural meta-learning shadows must share one bounded reward cohort and execute in parallel',
)
assert(
  metaShadowClosureBlock.includes('if (decisionRows.length === 0)') &&
    metaShadowClosureBlock.includes('not_run_no_current_decision_context'),
  'Meta shadow must close reward hydration without a neural 500 when the current decision cohort is not ready',
)
assert(
  postMarketChain.includes('recordWorkerTaskComputeProfile'),
  'post-market callback tasks must emit compute profile events from the shared task logger',
)
assert(
  postMarketChain.includes('assertStageLease') &&
    postMarketChain.includes('assertChainStageAuthority') &&
    updateOrchestrator.includes('startPipelineStageLeaseHeartbeat') &&
    updateOrchestrator.includes('isPipelineStageLeaseLost') &&
    updateOrchestrator.includes('terminalStillCurrent'),
  'post-pipeline and post-verify workers must heartbeat, assert authority at side-effect boundaries, and fence root telemetry',
)
assert(
  mlPipelineTrigger.indexOf('reservePipelineExecutionDispatch') < mlPipelineTrigger.indexOf('/pipeline/v2/run?date=') &&
    mlPipelineTrigger.indexOf('commitPipelineExecutionDispatch', mlPipelineTrigger.indexOf('/pipeline/v2/run?date=')) > mlPipelineTrigger.indexOf('/pipeline/v2/run?date=') &&
    pipelineStageLease.includes("stage='pipeline_execution'"),
  'pipeline dispatch must reserve D1 authority before controller fetch and commit the producer run id afterward',
)
assert(
  pipelineStageLease.match(/FROM strategy_learning_runs strategy_learning/g)?.length === 4,
  'both generic and authorized post-verify canonical transitions must share the live strategy-learning guard',
)
assert(
  pipelineStageLease.includes("expectedStatus: 'queued'") && pipelineStageLease.includes('requireUnleased: true'),
  'ambiguous queue send errors may only close a still-queued unleased stage',
)
assert(
  postMarketChain.includes('Promise.allSettled') &&
    postMarketChain.includes('withObservabilityTimeout') &&
    postMarketChain.includes('TASK_OBSERVABILITY_TIMEOUT_MS'),
  'post-market task observability writes must not let KV/profile logging block downstream chain tasks',
)
assert(
  postMarketChain.includes('withTaskExecutionTimeout') &&
    postMarketChain.includes('TASK_EXECUTION_TIMEOUT_MS') &&
    postMarketChain.includes("timeoutMs: TASK_EXECUTION_TIMEOUT_MS"),
  'non-critical evidence closures must have execution timeout protection so post-verify cannot leave evening-chain triggered forever',
)
assert(
  postVerifyQueueBlock.includes('stale post-verify finalizer ignored') &&
    postVerifyQueueBlock.includes('root chain closed after post-verify') &&
    postVerifyQueueBlock.indexOf('markPipelineStageFenced(env.DB') <
      postVerifyQueueBlock.indexOf("logSchedulerResult(env.KV, 'evening-chain'"),
  'post-verify root status must be written only after the canonical run and lease-owner finalizer succeeds',
)
assert(
  callbackRoutes.includes('root chain stopped at pipeline callback') &&
    callbackRoutes.includes('root chain stopped at verify-v2 callback') &&
    pipelineCallbackBlock.includes('post_pipeline_stage_owner_conflict') &&
    pipelineCallbackBlock.includes('post_pipeline_callback_chain_failed') &&
    !pipelineCallbackBlock.slice(pipelineCallbackBlock.indexOf('} catch (e: any) {'))
      .includes("logSchedulerResult(c.env.KV, 'evening-chain'"),
  'terminal pipeline/verify failures close their root; pre-adoption continuation failures remain retryable without stealing root ownership',
)
assert(
  allocatorSnapshotCallbackBlock.includes('isTransientD1Reset(callbackError)') &&
    allocatorSnapshotCallbackBlock.includes('allocator:snapshot-transient-retry:') &&
    allocatorSnapshotCallbackBlock.includes("type: 'allocator_ev_lifecycle_recovery'") &&
    allocatorSnapshotCallbackBlock.includes("status: 'running'") &&
    allocatorSnapshotCallbackBlock.includes("status: 'error'"),
  'allocator snapshot D1 transient callbacks must schedule bounded deduped recovery instead of closing root error',
)
assert(
  pipelineStageLease.includes("status='queued'") &&
    pipelineStageLease.includes('completed_at=NULL') &&
    pipelineStageLease.includes("status IN ('waiting', 'error')"),
  'durable stage recovery must clear terminal timestamps when resuming waiting/error state',
)
assert(logger.includes("'post-pipeline-chain'"), 'post-pipeline-chain must be visible in scheduler/OBS logs')
assert(logger.includes("'post-verify-chain'"), 'post-verify-chain must be visible in scheduler/OBS logs')
assert(logger.includes("'linucb-reward-ledger'"), 'LinUCB reward ledger must be visible in scheduler/OBS logs')
assert(logger.includes("'meta-learning-shadow'"), 'Neural shadow closure must be visible in scheduler/OBS logs')
assert(logger.includes("'ga-shadow-daily'"), 'GA frozen shadow closure must be visible in scheduler/OBS logs')
assert(
  adminTasks.includes("'meta-learning-shadow': async () =>") &&
    adminTasks.includes("type: 'meta_learning_shadow_closure'") &&
    adminTasks.includes('force: false'),
  'Meta shadow must have an evidence-only standalone admin retry path',
)
assert(
  schedulerPolicy.includes("'meta-learning-shadow': { kind: 'research', holidayGated: false"),
  'Meta shadow standalone retry must not be blocked by a market-session window',
)
assert(logger.includes("'strategy-learning'"), 'Strategy learning closure must be visible in scheduler/OBS logs')
assert(logger.includes("'s12-replay-backfill'"), 'S12 replay backfill must be visible in scheduler/OBS logs')
assert(logger.includes("'paper-intraday-cache-clear'"), 'paper intraday cache cleanup must be visible in scheduler/OBS logs')
assert(logger.includes("'paper-active-postmarket'"), 'paper-active postmarket must be visible in scheduler/OBS logs')
