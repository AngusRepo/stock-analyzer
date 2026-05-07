import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const callbackRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const postMarketChain = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const logger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const pipelineCallbackBlock = callbackRoutes.slice(
  callbackRoutes.indexOf("if (body.task === 'pipeline'"),
  callbackRoutes.indexOf("if (body.task === 'verify-v2'"),
)

assert(callbackRoutes.includes("body.task === 'pipeline'"), 'pipeline callback must be explicitly handled')
assert(callbackRoutes.includes('lock:ml-predict'), 'pipeline terminal callback must clear the ML predict lock')
assert(callbackRoutes.includes('runPostPipelineCallbackChain'), 'pipeline success callback must launch post-pipeline chain')
assert(callbackRoutes.includes('runPostVerifyCallbackChain'), 'verify success callback must launch post-verify chain')
assert(
  !pipelineCallbackBlock.includes('executionCtx.waitUntil'),
  'pipeline terminal callback must await post-pipeline chain before returning; waitUntil can silently drop verify trigger evidence',
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
  postMarketChain.includes('runModelIcRollingRefresh(env, ctx.runDate)'),
  'rolling IC refresh must receive the callback business date',
)
assert(
  postMarketChain.indexOf("runPostPipelineCallbackChain") < postMarketChain.indexOf("runPostVerifyCallbackChain"),
  'post-pipeline and post-verify chains must stay separate owners',
)
assert(
  postMarketChain.indexOf("'model-ic-tracker', () => runModelIcRollingRefresh") <
    postMarketChain.indexOf("'adapt', () => runAdaptiveUpdate"),
  'adaptive params must run after rolling IC evidence refresh',
)
assert(logger.includes("'post-pipeline-chain'"), 'post-pipeline-chain must be visible in scheduler/OBS logs')
assert(logger.includes("'post-verify-chain'"), 'post-verify-chain must be visible in scheduler/OBS logs')
