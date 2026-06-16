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
  !route.includes('function replaceChipReason'),
  'recommendations route should not keep legacy chip reason replacement helper',
)
assert(
  !route.includes('return `【籌碼】'),
  'recommendations route must not synthesize legacy tripartite reason labels',
)
