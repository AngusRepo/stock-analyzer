import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const callbackRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const researchWorkflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const strategyLearning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const controllerDailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
const pipelineCallbackBlock = callbackRoutes.slice(
  callbackRoutes.indexOf("if (body.task === 'pipeline'"),
  callbackRoutes.indexOf("const verifyCanContinue"),
)
const verifyCallbackBlock = callbackRoutes.slice(
  callbackRoutes.indexOf("const verifyCanContinue"),
  callbackRoutes.indexOf("if (body.task === 'verify-v2' && String(body.status) === 'error')"),
)
const postScreenerContinuationBlock = updateOrchestrator.slice(
  updateOrchestrator.indexOf('async function continuePostScreenerPipeline'),
  updateOrchestrator.indexOf('async function markShardComplete'),
)
const metaShadowBlock = postMarketChain.slice(
  postMarketChain.indexOf("'meta-learning-shadow', () => enqueueMetaLearningShadowClosureTask"),
  postMarketChain.indexOf("'strategy-learning', () => enqueueStrategyLearningClosureTask"),
)
const metaShadowClosureBlock = postMarketChain.slice(
  postMarketChain.indexOf('async function runMetaLearningShadowClosure'),
  postMarketChain.indexOf('async function enqueueStrategyLearningClosureTask'),
)

assert(callbackRoutes.includes("body.task === 'pipeline'"), 'pipeline callback must be explicitly handled')
assert(
  controllerDailyWorkflows.includes('verify-v2 already has an active execution') &&
    controllerDailyWorkflows.includes('triggered existing active verify-v2 execution'),
  'duplicate pipeline callbacks must reuse an active verify execution instead of failing the root chain',
)
assert(callbackRoutes.includes('lock:ml-predict'), 'pipeline terminal callback must clear the ML predict lock')
assert(
  callbackRoutes.includes("type: 'post_pipeline_chain'") &&
    callbackRoutes.includes('callback:post-pipeline-enqueued:'),
  'pipeline success callback must durably and idempotently queue the post-pipeline chain',
)
assert(
  callbackRoutes.includes("type: 'post_verify_chain'") &&
    callbackRoutes.includes('callback:post-verify-enqueued:'),
  'verify terminal callback must durably and idempotently queue the post-verify chain',
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
    verifyCallbackBlock.includes("type: 'post_verify_chain'"),
  'verify terminal callback must use the durable queue instead of a bounded waitUntil continuation',
)

assert(
  postMarketChain.includes('isCurrentBusinessDate'),
  'current-date-only tasks must be guarded so historical reruns cannot dirty current reports',
)
assert(
  postMarketChain.includes('runVerifyV2(env, ctx.runDate)'),
  'verify-v2 must receive the callback business date',
)
assert(
  postMarketChain.includes('runAllocatorEvFeatureSnapshotBackfill') &&
    postMarketChain.indexOf("'allocator-ev-feature-snapshot-backfill'") <
      postMarketChain.indexOf("'verify-v2'"),
  'same-date allocator feature snapshots must be materialized after pipeline output and before verify',
)
assert(
  postMarketChain.includes("snapshotTask.status === 'error' || !snapshotClosure.ready") &&
    postMarketChain.includes("await logChainSummary(env, ctx, 'post-pipeline-chain'"),
  'post-pipeline chain must stop before verify when canonical allocator snapshots are missing',
)
assert(
  researchWorkflows.includes('durable: !(params.dryRun ?? false)') &&
    researchWorkflows.includes('upstream_run_id: params.runId') &&
    postMarketChain.includes("/\\bstatus=(?:spawned|pending)\\b/i") &&
    callbackRoutes.includes("body.task === 'allocator-ev-feature-snapshot-backfill'") &&
    callbackRoutes.includes('callback:post-pipeline-enqueued:snapshot:'),
  'allocator snapshots must use a durable job and resume the same post-pipeline chain from its callback',
)
assert(
  postScreenerContinuationBlock.indexOf('runRegimeCompute(env, triggerTime)') > 0 &&
    postScreenerContinuationBlock.indexOf('runRegimeCompute(env, triggerTime)') <
      postScreenerContinuationBlock.indexOf('deps.runMLAndRiskV2(env, triggerTime'),
  'regime-compute must run with the chain business date before pipeline/recommendation so market_regime_state is not null or future-dated',
)
assert(
  updateOrchestrator.includes("type: 'post_screener_pipeline'") &&
    updateOrchestrator.includes("if (msg.type === 'post_screener_pipeline')") &&
    updateOrchestrator.includes('continuePostScreenerPipeline(env, deps, triggerTime, runId)'),
  'indicator-queue finalization must enqueue and consume post-screener continuation instead of requiring manual pipeline trigger',
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
  strategyLearning.includes('listStrategyLearningCandidates(db, options.date, limit + 1, offset)') &&
    strategyLearning.includes('const hasMore = candidatePage.length > limit') &&
    strategyLearning.includes('const candidates = candidatePage.slice(0, limit)') &&
    strategyLearning.includes('has_more: hasMore'),
  'strategy-learning pagination must use limit+1 lookahead so exact-multiple pages close without an empty terminal message',
)
assert(
  postMarketChain.indexOf("runPostPipelineCallbackChain") < postMarketChain.indexOf("runPostVerifyCallbackChain"),
  'post-pipeline and post-verify chains must stay separate owners',
)
assert(
  postMarketChain.indexOf("'model-ic-tracker', () => runModelIcRollingRefresh") <
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
  postMarketChain.includes('force: isCurrentBusinessDate(runDate)'),
  'historical strategy-learning reruns must not refresh live strategy_policy_state in queued closure',
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
  metaShadowClosureBlock.includes('const sourceRows = await listLinUcbRewardSourceRows') &&
    metaShadowClosureBlock.includes('Promise.all([') &&
    metaShadowClosureBlock.match(/sourceRows,/g)?.length === 3,
  'Neural meta-learning shadows must share one bounded reward cohort and execute in parallel',
)
assert(
  postMarketChain.includes('recordWorkerTaskComputeProfile'),
  'post-market callback tasks must emit compute profile events from the shared task logger',
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
  postMarketChain.includes("task === 'post-verify-chain'") &&
    postMarketChain.includes("'evening-chain'") &&
    postMarketChain.includes('root chain closed after post-verify'),
  'post-verify closure must write final evening-chain status so OBS does not treat pipeline trigger as full-chain success',
)
assert(
  callbackRoutes.includes('root chain stopped at pipeline callback') &&
    callbackRoutes.includes('root chain stopped at verify-v2 callback') &&
    callbackRoutes.includes('root chain stopped in post-pipeline callback chain'),
  'terminal pipeline/verify callback failures must close evening-chain as error instead of leaving it triggered; durable continuation failures retry in queue',
)
assert(logger.includes("'post-pipeline-chain'"), 'post-pipeline-chain must be visible in scheduler/OBS logs')
assert(logger.includes("'post-verify-chain'"), 'post-verify-chain must be visible in scheduler/OBS logs')
assert(logger.includes("'linucb-reward-ledger'"), 'LinUCB reward ledger must be visible in scheduler/OBS logs')
assert(logger.includes("'meta-learning-shadow'"), 'Neural shadow closure must be visible in scheduler/OBS logs')
assert(logger.includes("'strategy-learning'"), 'Strategy learning closure must be visible in scheduler/OBS logs')
assert(logger.includes("'s12-replay-backfill'"), 'S12 replay backfill must be visible in scheduler/OBS logs')
assert(logger.includes("'paper-intraday-cache-clear'"), 'paper intraday cache cleanup must be visible in scheduler/OBS logs')
assert(logger.includes("'paper-active-postmarket'"), 'paper-active postmarket must be visible in scheduler/OBS logs')
