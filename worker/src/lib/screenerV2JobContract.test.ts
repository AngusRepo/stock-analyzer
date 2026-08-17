import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const screenerJobMain = fs.readFileSync('src/node-runner/screenerJobMain.ts', 'utf8')
const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const pipelineOrchestrator = fs.readFileSync('src/lib/pipelineOrchestrator.ts', 'utf8')
const strategySpec = fs.readFileSync('src/lib/strategySpec.ts', 'utf8')
const multiStrategyPleRouter = fs.readFileSync('src/lib/multiStrategyPleRouter.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const screenerJobTrigger = fs.readFileSync('src/lib/screenerJobTrigger.ts', 'utf8')
const index = fs.readFileSync('src/index.ts', 'utf8')

assert(
  updateOrchestrator.includes('runMarketScreenerAsync') &&
    updateOrchestrator.includes('triggerCanonicalScreenerStage') &&
    updateOrchestrator.includes('canonicalRunId: runId') &&
    updateOrchestrator.includes('trigger: runAsyncScreener') &&
    updateOrchestrator.includes('awaiting callback') &&
    updateOrchestrator.includes('return'),
  'evening-chain finalizer must trigger screener-v2 asynchronously and stop until callback',
)

assert(
  updateOrchestrator.includes("from './postScreenerContinuation'") &&
    updateOrchestrator.includes('enqueuePostScreenerPipelineContinuation(env, {'),
  'legacy direct screener fallback must use the shared post-screener continuation helper',
)

assert(
  adminControlRoutes.includes('recordCanonicalScreenerCallback') &&
    adminControlRoutes.includes('producerRunId: callbackRunId') &&
  adminControlRoutes.includes("body.task === 'screener'") &&
    adminControlRoutes.includes('continue_post_screener_pipeline') &&
    adminControlRoutes.includes('chain_run_id') &&
    adminControlRoutes.includes("source: 'screener-v2-callback'"),
  'screener scheduler callback must enqueue post-screener continuation only with explicit chain context',
)

assert(
  index.includes("import { runScreenerV2 } from './lib/screenerJobTrigger'") &&
    index.includes('runMarketScreenerAsync: runScreenerV2'),
  'Worker queue consumer must inject screener-v2 trigger for evening-chain finalizer',
)

assert(
  screenerJobTrigger.includes('res.status === 409') &&
    screenerJobTrigger.includes('refusing to wait on an unrelated callback') &&
    !screenerJobTrigger.includes('LOCKED screener-v2 active execution'),
  'screener-v2 active Cloud Run Job collisions must fail closed, not leave evening-chain waiting forever',
)

assert(
  screenerJobMain.includes('const observedTaipeiDate = twToday()') &&
    screenerJobMain.includes("historicalLearningLineageDecision(env.DB, env.KV, 'screener-v2', runDate)") &&
    screenerJobMain.includes('runDate === observedTaipeiDate || historicalBoundary?.allowed') &&
    screenerJobMain.includes("? 'live_current' : 'historical_replay'") &&
    screenerJobMain.includes('runBottomUpScreener(env, runDate, { producerRunId: runId, evidenceMode })') &&
    screenerJobMain.includes('funnelRunByProducerId') &&
    screenerJobMain.includes('AND run_id = ?') &&
    marketScreener.includes('resolveScreenerProducerRunId(endDate, options.producerRunId)') &&
    marketScreener.includes('evidenceMode?: StrategyEvidenceMode') &&
    marketScreener.includes('evidenceMode: monthlyRevenue.evidenceMode') &&
    pipelineOrchestrator.includes('resolveMarketScreenerEvidenceMode') &&
    pipelineOrchestrator.includes('runBottomUpScreener(env, resolved.runDate, { evidenceMode: resolved.evidenceMode })'),
  'Cloud Run producer run id must be the exact screener funnel identity used by callback closure',
)

assert(
  strategySpec.includes("STRATEGY_FORMAL_LABELER_VERSION = 'strategy-labeler-v2-revenue-pit-fuse-v1'") &&
    multiStrategyPleRouter.includes('STRATEGY_LABELER_VERSION = STRATEGY_FORMAL_LABELER_VERSION') &&
    !multiStrategyPleRouter.includes("STRATEGY_LABELER_VERSION = 'strategy-labeler-v1'"),
  'screener router must publish only the formal PIT-safe strategy labeler identity',
)

assert(
  marketScreener.includes('screener_market_data_load_failed') &&
    marketScreener.includes('screener_market_data_empty') &&
    !marketScreener.includes("console.error('[Screener v2] Data fetch failed:', e)"),
  'screener infrastructure/data absence must throw instead of returning an empty successful slate',
)

assert(
  screenerJobMain.includes('screener_completion_invalid') &&
    screenerJobMain.includes('universeCount <= 0') &&
    screenerJobMain.includes('process.exitCode = 1'),
  'node runner must reject missing/zero-universe funnel closure and exit non-zero',
)
