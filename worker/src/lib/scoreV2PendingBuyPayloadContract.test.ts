import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperRoute = readFileSync('src/routes/paper.ts', 'utf8')
const pendingBuyStore = readFileSync('src/lib/pendingBuyStore.ts', 'utf8')

assert(
  paperRoute.includes('serializeScoreV2Snapshot'),
  'pending-buy paper route should use the shared Score V2 serializer',
)
assert(
  paperRoute.includes('readScoreV2Snapshot'),
  'pending-buy paper route should normalize DB projection through readScoreV2Snapshot',
)
assert(
  paperRoute.includes('dr.score_components'),
  'pending-buy enrichment query should load canonical daily recommendation score_components',
)
assert(
  paperRoute.includes('dr.date <= ?'),
  'pending-buy enrichment should use latest available daily recommendation on or before source date',
)
assert(
  paperRoute.includes('stock_id: item.stock_id ?? context.stock_id ?? null'),
  'pending-buy card payload should carry stock_id for per-symbol chart fetches',
)
for (const legacySelect of [
  'dr.ml_score',
  'dr.chip_score',
  'dr.tech_score',
  'dr.score,',
  'COALESCE(dr.momentum_score',
]) {
  assert(
    !paperRoute.includes(legacySelect),
    `pending-buy enrichment query should not load legacy daily_recommendations field ${legacySelect}`,
  )
}
assert(
  paperRoute.includes('score_v2: context.score_v2 ?? fallbackScoreV2'),
  'pending-buy API response should expose score_v2 for Bot Dashboard cards',
)
assert(
  paperRoute.includes('function removeLegacyPendingBuyScoreFields'),
  'pending-buy API route should strip storage-only legacy score columns before responding',
)
for (const legacyProjection of [
  'score: _score',
  'total_score: _totalScore',
  'chip_score: _chipScore',
  'tech_score: _techScore',
  'ml_score: _mlScore',
  'momentum_score: _momentumScore',
  'score_components: _scoreComponents',
]) {
  assert(
    paperRoute.includes(legacyProjection),
    `pending-buy API response stripper should remove ${legacyProjection}`,
  )
}
assert(
  paperRoute.includes('pendingBuys: pendingBuysForResponse'),
  'pending-buy API response should return stripped pending-buy items',
)
assert(
  paperRoute.includes('runHistory: stripLegacyPendingBuyRunHistory(runHistory)'),
  'pending-buy API response should strip legacy score fields from run history items',
)
assert(
  paperRoute.includes('const fallbackScoreV2 = item.score_v2') && paperRoute.includes('?? null'),
  'pending-buy API response should only reuse an existing canonical pending-buy score_v2 fallback',
)
assert(
  !paperRoute.includes('readScoreV2Snapshot(item as ScoreV2StorageRow)'),
  'pending-buy API response must not try to synthesize Score V2 from pending_buy_items legacy columns',
)
assert(
  !paperRoute.includes('serializeScoreV2Snapshot(readScoreV2Snapshot'),
  'pending-buy API response must guard nullable Score V2 snapshots before serializing',
)

const scoreV2LoaderStart = pendingBuyStore.indexOf('async function loadPendingBuyScoreV2BySymbol')
const scoreV2LoaderEnd = pendingBuyStore.indexOf('function enrichPendingBuysWithScoreV2', scoreV2LoaderStart)
assert(scoreV2LoaderStart >= 0 && scoreV2LoaderEnd > scoreV2LoaderStart, 'pending-buy D1 Score V2 enrichment loader should be locatable')
const scoreV2LoaderBlock = pendingBuyStore.slice(scoreV2LoaderStart, scoreV2LoaderEnd)
assert(
  scoreV2LoaderBlock.includes('SELECT symbol, score_components'),
  'pending-buy D1 snapshots should enrich score_v2 from canonical daily_recommendations.score_components',
)
assert(
  scoreV2LoaderBlock.includes('readScoreV2Snapshot(row as ScoreV2StorageRow)'),
  'pending-buy D1 snapshots should parse canonical Score V2 payloads through shared reader',
)
assert(
  scoreV2LoaderBlock.includes('serializeScoreV2Snapshot(snapshot)'),
  'pending-buy D1 snapshots should expose canonical score_v2 summaries',
)
for (const legacySelect of ['chip_score', 'tech_score', 'ml_score', 'momentum_score', 'score,']) {
  assert(!scoreV2LoaderBlock.includes(legacySelect), `pending-buy D1 score_v2 enrichment must not read legacy ${legacySelect}`)
}
const projectionStart = pendingBuyStore.indexOf('export function normalizePendingBuyScoreProjection')
const projectionEnd = pendingBuyStore.indexOf('function normalizePendingBuyScoreProjections', projectionStart)
assert(projectionStart >= 0 && projectionEnd > projectionStart, 'pending-buy score projection helper should be locatable')
const projectionBlock = pendingBuyStore.slice(projectionStart, projectionEnd)
for (const canonicalProjection of [
  'chip_score: scoreV2?.components.chipFlow ?? null',
  'tech_score: scoreV2?.components.technicalStructure ?? null',
  'ml_score: scoreV2?.components.mlEdge ?? null',
  'score: scoreV2?.finalScore ?? null',
]) {
  assert(projectionBlock.includes(canonicalProjection), `pending-buy projection should derive ${canonicalProjection} from score_v2 only`)
}
for (const legacyFallback of ['item.chip_score ??', 'item.tech_score ??', 'item.ml_score ??', 'item.score ??']) {
  assert(!projectionBlock.includes(legacyFallback), `pending-buy projection must not preserve legacy fallback ${legacyFallback}`)
}
assert(
  pendingBuyStore.includes('const enrichedPendingBuys = enrichPendingBuysWithScoreV2(pendingBuys, scoreV2BySymbol)'),
  'loadPendingBuySnapshot and run history should enrich D1 pending buys before sorting',
)
assert(
  pendingBuyStore.includes('function sortPendingBuysByScoreV2'),
  'pending-buy snapshots should own canonical Score V2 ordering',
)
const sortStart = pendingBuyStore.indexOf('function sortPendingBuysByScoreV2')
const sortEnd = pendingBuyStore.indexOf('function rowsToCounts', sortStart)
assert(sortStart >= 0 && sortEnd > sortStart, 'pending-buy Score V2 sort helper should be locatable')
const sortBlock = pendingBuyStore.slice(sortStart, sortEnd)
assert(sortBlock.includes('score_v2?.finalScore'), 'pending-buy sorting should use canonical score_v2 finalScore')
assert(!sortBlock.includes('.score ??'), 'pending-buy sorting must not fall back to storage scalar score')
assert(!pendingBuyStore.includes('ORDER BY score DESC'), 'pending-buy D1 reads must not sort by storage scalar score')
assert(
  pendingBuyStore.includes('pendingBuys: sortPendingBuysByScoreV2(normalizePendingBuyScoreProjections(raw ?? []))'),
  'KV pending-buy snapshots should also sort by canonical score_v2 when available',
)
assert(
  pendingBuyStore.includes('pendingBuys: sortPendingBuysByScoreV2(enrichedPendingBuys)'),
  'loadPendingBuySnapshot should return D1 pending buys sorted by canonical score_v2',
)
assert(
  pendingBuyStore.includes('items: sortPendingBuysByScoreV2(enrichedPendingBuys)'),
  'pending-buy run history should return D1 items sorted by canonical score_v2',
)
