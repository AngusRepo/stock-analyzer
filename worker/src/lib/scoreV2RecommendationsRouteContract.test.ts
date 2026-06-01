import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = readFileSync('src/routes/other.ts', 'utf8')

assert(
  route.includes('has_buy_signal = 1') &&
    route.includes("json_extract(alpha_allocation, '$.selected') = 1"),
  'recommendations route must only resolve allocator-selected BUY rows as final recommendations',
)

assert(
  route.includes('mergeEmergingBrokerReason'),
  'recommendations route should merge emerging broker evidence through Score V2 reason semantics',
)
assert(
  route.includes('籌碼流：'),
  'emerging broker evidence should be labeled for user-facing Chinese UI',
)
assert(
  !route.includes('chipFlowEvidence:'),
  'emerging broker evidence should not leak debug-prefixed score_components.reasons',
)
assert(
  route.includes('!/^chip_source=/i.test(p)')
    && !route.includes('`chip_source=${'),
  'emerging broker evidence should filter raw chip_source watch point text instead of appending it',
)
assert(
  route.includes('removeLegacyRecommendationScoreFields'),
  'recommendations daily route should strip legacy score projection fields before responding',
)
assert(
  route.includes('score_v2: scoreV2'),
  'recommendations daily route should expose canonical score_v2 payload',
)
assert(
  route.includes('score: scoreV2?.finalScore ?? null'),
  'recommendations daily route scalar score should be derived from Score V2 finalScore',
)
assert(
  route.includes('score: _score'),
  'recommendations daily route should strip storage scalar score before response shaping',
)
assert(
  route.includes('total_score: _totalScore'),
  'recommendations daily route should strip storage scalar total_score before response shaping',
)
assert(
  route.includes('const snapshot = readScoreV2Snapshot(row as ScoreV2StorageRow)'),
  'recommendations route should treat Score V2 snapshot reads as nullable',
)
assert(
  route.includes('snapshot ? serializeScoreV2Snapshot(snapshot) : null'),
  'recommendations route must not synthesize Score V2 from legacy scalar columns',
)
assert(
  !route.includes('function replaceChipReason'),
  'recommendations route should not keep legacy chip reason replacement helper',
)
assert(
  !route.includes('return `【籌碼】'),
  'recommendations route must not synthesize legacy tripartite reason labels',
)

const dailyStart = route.indexOf("recommendations.get('/daily'")
const dailyEnd = route.indexOf("recommendations.get('/history'")
assert(dailyStart >= 0 && dailyEnd > dailyStart, 'recommendations daily route should be locatable')
const dailyBlock = route.slice(dailyStart, dailyEnd)
assert(
  dailyBlock.includes('WHERE r.date = ?') && dailyBlock.includes('AND ${FINAL_RECOMMENDATION_WHERE}'),
  'recommendations daily payload query must apply the final BUY allocation predicate',
)
const responseMapStart = dailyBlock.indexOf('return {')
const responseMapEnd = dailyBlock.indexOf('const evidenceLinksBySymbol')
assert(responseMapStart >= 0 && responseMapEnd > responseMapStart, 'recommendations daily response shaping block should be locatable')
const responseMapBlock = dailyBlock.slice(responseMapStart, responseMapEnd)
for (const legacyOutput of [
  'score_components: scoreComponents',
  'total_score:',
  'ml_score:',
  'chip_score:',
  'tech_score:',
  'momentum_score:',
]) {
  assert(!responseMapBlock.includes(legacyOutput), `recommendations daily response should not expose ${legacyOutput}`)
}
