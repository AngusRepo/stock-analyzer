const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const pendingBuyOrchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')

assert(
  marketScreener.includes("from './breeze2Runtime'"),
  'marketScreener must import Breeze2 runtime helper',
)
assert(
  marketScreener.includes('enrichScreenerCandidatesWithBreeze2'),
  'screener must enrich bounded shortlist with Breeze2 context',
)
assert(
  marketScreener.includes("stage: 'breeze2_semantic_context'"),
  'screener must persist Breeze2 sidecar evidence into screener_funnel_items',
)
assert(
  pendingBuyOrchestrator.includes("from './breeze2Runtime'"),
  'pending-buy orchestrator must import Breeze2 runtime helper',
)
assert(
  pendingBuyOrchestrator.includes('enrichMorningDebateCandidatesWithBreeze2'),
  'morning debate candidates must be enriched with Breeze2 context before /debate/buy_batch',
)
assert(
  pendingBuyOrchestrator.includes('breeze2_context'),
  'pending-buy debate payload must pass breeze2_context to Controller debate',
)
