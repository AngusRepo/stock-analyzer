const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const pendingBuyOrchestrator = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const screenerBreeze2Start = marketScreener.indexOf('const breeze2ScreenerContext = await enrichScreenerCandidatesWithBreeze2')
const screenerBreeze2End = marketScreener.indexOf(').catch((error) => {', screenerBreeze2Start)

assert(
  marketScreener.includes("from './breeze2Runtime'"),
  'marketScreener must import Breeze2 runtime helper',
)
assert(
  marketScreener.includes('enrichScreenerCandidatesWithBreeze2'),
  'screener must enrich bounded shortlist with Breeze2 context',
)
assert(
  screenerBreeze2Start >= 0 && screenerBreeze2End > screenerBreeze2Start,
  'screener Breeze2 enrichment block should be locatable',
)
const screenerBreeze2Block = marketScreener.slice(screenerBreeze2Start, screenerBreeze2End)
assert(
  screenerBreeze2Block.includes('score_v2: rawCandidate.score_v2 ?? rawCandidate.score_components ?? null'),
  'screener Breeze2 context must normalize storage score_components into score_v2',
)
assert(
  !screenerBreeze2Block.includes('...candidate'),
  'screener Breeze2 context must not spread legacy screener candidate fields',
)
for (const legacyField of ['score:', 'chip_score', 'tech_score', 'momentum_score', 'ml_score']) {
  assert(!screenerBreeze2Block.includes(legacyField), `screener Breeze2 context must not pass legacy ${legacyField}`)
}
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
