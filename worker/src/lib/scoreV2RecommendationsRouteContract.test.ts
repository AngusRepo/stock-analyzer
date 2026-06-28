import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = readFileSync('src/routes/other.ts', 'utf8')

assert(
  route.includes('mergeEmergingBrokerReason'),
  'recommendations route should merge emerging broker evidence through Score V2 reason semantics',
)
assert(
  route.includes('Score V2 Chip Flow evidence'),
  'emerging broker evidence should be labeled as Score V2 Chip Flow evidence',
)
assert(
  route.includes('chipFlowEvidence:'),
  'emerging broker evidence should be preserved inside score_components.reasons',
)
assert(
  route.includes('FINAL_RECOMMENDATION_ROW_WHERE')
    && route.includes("r.signal IS NOT NULL AND r.confidence IS NOT NULL AND r.score_components LIKE '%score_v2%'")
    && route.includes('WHERE r.date = ? AND ${FINAL_RECOMMENDATION_ROW_WHERE}'),
  'daily recommendations route must not return L1 seed/observe rows as recommendation cards',
)
assert(
  !/WHERE r\.date = \? AND \$\{FINAL_RECOMMENDATION_ROW_WHERE\}[\s\S]*ORDER BY r\.rank ASC\s+LIMIT 80/.test(route),
  'daily recommendations route must return the complete final set before frontend card limits so BUY/potential BUY rows beyond rank 80 stay visible',
)
assert(
  !route.includes('function replaceChipReason'),
  'recommendations route should not keep legacy chip reason replacement helper',
)
assert(
  !route.includes('return `【籌碼】'),
  'recommendations route must not synthesize legacy tripartite reason labels',
)
assert(
  route.includes('broker_level_top5')
    && route.includes('.slice(0, 5)')
    && route.includes('top_buy: topBuy')
    && route.includes('top_sell: topSell'),
  'daily recommendations route should expose broker branch top-five buy/sell rows',
)
for (const text of [
  'function buildDailyPipelineSummaries',
  'daily_pipeline_funnel_summary_v1',
  'daily_active_strategy_summary_v1',
  'screener_funnel_runs + screener_funnel_items',
  'funnel_summary: pipelineSummaries.funnel_summary',
  'strategy_summary: pipelineSummaries.strategy_summary',
]) {
  assert(route.includes(text), `daily recommendations route should expose flow-tracking summary contract: ${text}`)
}
