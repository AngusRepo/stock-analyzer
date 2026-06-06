import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const callbackRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const pipelineCallbackBlock = callbackRoutes.slice(
  callbackRoutes.indexOf("if (body.task === 'pipeline'"),
  callbackRoutes.indexOf("const verifyCanContinue"),
)
const verifyCallbackBlock = callbackRoutes.slice(
  callbackRoutes.indexOf("const verifyCanContinue"),
  callbackRoutes.indexOf("if (body.task === 'verify-v2' && String(body.status) === 'error')"),
)

assert(callbackRoutes.includes("body.task === 'pipeline'"), 'pipeline callback must be explicitly handled')
assert(callbackRoutes.includes('lock:ml-predict'), 'pipeline terminal callback must clear the ML predict lock')
assert(callbackRoutes.includes('runPostPipelineCallbackChain'), 'pipeline success callback must launch post-pipeline chain')
assert(callbackRoutes.includes('runPostVerifyCallbackChain'), 'verify terminal callback must launch post-verify chain')
assert(
  callbackRoutes.includes("['success', 'skipped'].includes(String(body.status))"),
  'verify-v2 skipped callback must continue post-verify chain for replay dates with no matured prediction window',
)
assert(
  !pipelineCallbackBlock.includes('executionCtx.waitUntil'),
  'pipeline terminal callback must await post-pipeline chain before returning; waitUntil can silently drop verify trigger evidence',
)
assert(
  !verifyCallbackBlock.includes('executionCtx.waitUntil'),
  'verify terminal callback must await post-verify chain before returning; waitUntil can silently drop final closure evidence',
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
  updateOrchestrator.indexOf('runRegimeCompute(env, triggerTime)') > 0 &&
    updateOrchestrator.indexOf('runRegimeCompute(env, triggerTime)') < updateOrchestrator.indexOf('deps.runMLAndRiskV2(env, triggerTime)'),
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
  postMarketChain.indexOf("runPostPipelineCallbackChain") < postMarketChain.indexOf("runPostVerifyCallbackChain"),
  'post-pipeline and post-verify chains must stay separate owners',
)
assert(
  postMarketChain.indexOf("'model-ic-tracker', () => runModelIcRollingRefresh") <
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
    postMarketChain.indexOf("'meta-learning-shadow', () => runMetaLearningShadowClosure"),
  'Neural meta-learning shadow evidence must not block adaptive params, report, or obsidian sync',
)
assert(
  postMarketChain.indexOf("'meta-learning-shadow', () => runMetaLearningShadowClosure") <
    postMarketChain.indexOf("'strategy-learning', () => runStrategyLearningClosureTask"),
  'Strategy learning reward closure should run after model/meta-learning evidence is available',
)
assert(
  !postMarketChain.includes("logSkippedHistoricalTask(env, ctx, 'strategy-learning')"),
  'Strategy learning must run for historical reruns so strategy_decision_log can materialize replay-date family evidence',
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
  postMarketChain.includes('recordWorkerTaskComputeProfile'),
  'post-market callback tasks must emit compute profile events from the shared task logger',
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
    callbackRoutes.includes('root chain stopped in post-pipeline callback chain') &&
    callbackRoutes.includes('root chain stopped in post-verify callback chain'),
  'terminal pipeline/verify callback failures must close evening-chain as error instead of leaving it triggered',
)
assert(logger.includes("'post-pipeline-chain'"), 'post-pipeline-chain must be visible in scheduler/OBS logs')
assert(logger.includes("'post-verify-chain'"), 'post-verify-chain must be visible in scheduler/OBS logs')
assert(logger.includes("'linucb-reward-ledger'"), 'LinUCB reward ledger must be visible in scheduler/OBS logs')
assert(logger.includes("'meta-learning-shadow'"), 'Neural shadow closure must be visible in scheduler/OBS logs')
assert(logger.includes("'strategy-learning'"), 'Strategy learning closure must be visible in scheduler/OBS logs')
assert(logger.includes("'paper-active-postmarket'"), 'paper-active postmarket must be visible in scheduler/OBS logs')
