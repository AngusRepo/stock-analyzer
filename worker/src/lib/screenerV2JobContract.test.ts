import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const screenerJobTrigger = fs.readFileSync('src/lib/screenerJobTrigger.ts', 'utf8')
const index = fs.readFileSync('src/index.ts', 'utf8')

assert(
  updateOrchestrator.includes('runMarketScreenerAsync') &&
    updateOrchestrator.includes('await runAsyncScreener(env, triggerTime, { chainRunId: runId })') &&
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
