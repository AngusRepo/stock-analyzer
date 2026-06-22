import {
  buildFinLabTaxonomyThemeSignals,
  buildStockThemeFeatureRows,
  buildV41SourceCoverageRows,
  upsertStockThemeFeatures,
  upsertThemeSignals,
} from './v41DataRuntime'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const features = buildStockThemeFeatureRows(
  [
    {
      date: '2026-05-15',
      concept: 'AI_Server',
      source: 'official_rss',
      score: 0.8,
      sentiment_avg: 0.1,
      evidence_count: 2,
      top_titles: JSON.stringify(['official headline']),
      generated_at: '2026-05-15T18:00:00+08:00',
    },
    {
      date: '2026-05-15',
      concept: 'AI_Server',
      source: 'ptt',
      score: 1.2,
      sentiment_avg: 0.3,
      evidence_count: 4,
      top_titles: JSON.stringify(['ptt headline']),
      generated_at: '2026-05-15T18:00:00+08:00',
    },
    {
      date: '2026-05-15',
      concept: 'SUPPLY_CHAIN_RISK',
      source: 'gdelt_events',
      score: 0.2,
      sentiment_avg: -0.5,
      evidence_count: 1,
      top_titles: JSON.stringify(['gdelt headline']),
      generated_at: '2026-05-15T18:00:00+08:00',
    },
  ],
  [
    { symbol: '2330', tag: 'AI_Server', weight: 1 },
    { symbol: '6669', tag: 'AI_Server', weight: 0.5 },
    { symbol: '2330', tag: 'SUPPLY_CHAIN_RISK', weight: 0.3 },
  ],
)

const bySymbolConcept = new Map(features.map(row => [`${row.symbol}:${row.concept}`, row]))
const tsmcAi = bySymbolConcept.get('2330:AI_Server')
const wiynnAi = bySymbolConcept.get('6669:AI_Server')
const risk = bySymbolConcept.get('2330:SUPPLY_CHAIN_RISK')

assert(features.length === 3, 'theme signals should map into symbol-level feature rows')
assert(tsmcAi?.score === 2, 'same concept from multiple sources should aggregate by symbol/concept')
assert(tsmcAi?.evidence_count === 6, 'evidence count should aggregate across sources')
assert(JSON.parse(tsmcAi?.source_breakdown_json ?? '{}').official_rss === 0.8, 'source breakdown must preserve official contribution')
assert(JSON.parse(tsmcAi?.source_breakdown_json ?? '{}').ptt === 1.2, 'source breakdown must preserve PTT contribution')
assert(wiynnAi?.score === 1, 'stock tag weight must scale theme feature score')
assert(risk?.score === 0.06, 'GDELT risk context can map to stock feature rows with low weighted score')

const taxonomySignals = buildFinLabTaxonomyThemeSignals(
  [
    { symbol: '2330', tag: 'Semiconductor', tag_type: 'industry_theme', weight: 0.9 },
    { symbol: '6669', tag: 'Semiconductor', tag_type: 'industry_theme', weight: 0.8 },
    { symbol: '2330', tag: 'Foundry', tag_type: 'subindustry', weight: 0.8 },
  ],
  '2026-05-15',
  '2026-05-15T18:00:00+08:00',
)
const semiSignal = taxonomySignals.find(row => row.concept === 'Semiconductor')
assert(semiSignal?.source === 'finlab_taxonomy', 'FinLab taxonomy must become traceable theme signal source')
assert(semiSignal?.evidence_count === 2, 'FinLab taxonomy evidence count should preserve covered symbol count')
assert(JSON.parse(semiSignal?.symbols_json ?? '[]').includes('2330'), 'FinLab taxonomy signal should keep symbols_json lineage')

const sourceCoverage = buildV41SourceCoverageRows({
  qualityRows: [
    {
      source: 'finlab',
      dataset: 'canonical_market_daily',
      freshness_status: 'fresh',
      missing_rate: 0.02,
      duplicate_rate: 0,
      schema_drift_status: 'ok',
      entity_link_confidence: 0.99,
      latest_materialization: '2026-05-18T08:00:00+08:00',
    },
  ],
  themeRows: [
    { source: 'finlab_taxonomy', rows: 12, latest_generated_at: '2026-05-18T08:00:00+08:00' },
    { source: 'ptt', rows: 5, latest_generated_at: '2026-05-18T07:30:00+08:00' },
  ],
  evidenceRows: [
    { source: 'official', rows: 3, latest_published_at: '2026-05-18T06:00:00+08:00', entity_link_confidence: 0.96 },
  ],
})
const finlabCoverage = sourceCoverage.find(row => row.source === 'finlab')
const gdeltCoverage = sourceCoverage.find(row => row.source === 'gdelt_events')
const officialCoverage = sourceCoverage.find(row => row.source === 'official_rss')
const irCoverage = sourceCoverage.find(row => row.source === 'company_ir_rss')
assert(finlabCoverage?.rows === 12, 'FinLab taxonomy should roll into FinLab source coverage')
assert(finlabCoverage?.runtime_state === 'production', 'FinLab non-empty coverage should be production runtime')
assert(!sourceCoverage.some(row => row.source === 'finnhub_news'), 'Finnhub must not be part of V4.1 production source coverage')
assert(officialCoverage?.rows === 3, 'official evidence rows should be visible in source coverage')
assert(officialCoverage?.entity_link_confidence === 0.96, 'source coverage must expose entity-link confidence')
assert(irCoverage?.runtime_state === 'disabled', 'company IR should stay disabled until curated allowlist exists')
assert(gdeltCoverage?.runtime_state === 'missing', 'missing formal-shadow GDELT should be fail-visible, not invisible')

function makeThemeBatchDb() {
  const batchSizes: number[] = []
  const db = {
    prepare(_sql: string) {
      return {
        bind(..._params: unknown[]) {
          return this
        },
      }
    },
    async batch(statements: unknown[]) {
      batchSizes.push(statements.length)
      return []
    },
  } as unknown as D1Database
  return { db, batchSizes }
}

void (async () => {
  const generatedAt = '2026-06-22T18:00:00+08:00'
  const themeRows = Array.from({ length: 121 }, (_, index) => ({
    date: '2026-06-22',
    concept: `concept-${index}`,
    source: 'finlab_taxonomy',
    score: 1,
    evidence_count: 1,
    symbols_json: '[]',
    top_titles: '[]',
    generated_at: generatedAt,
  }))
  const featureRows = Array.from({ length: 121 }, (_, index) => ({
    date: '2026-06-22',
    symbol: `${1000 + index}`,
    concept: `concept-${index}`,
    score: 1,
    evidence_count: 1,
    source_breakdown_json: '{}',
    top_titles: '[]',
    generated_at: generatedAt,
  }))

  const themeDb = makeThemeBatchDb()
  const featureDb = makeThemeBatchDb()

  await upsertThemeSignals(themeDb.db, themeRows)
  await upsertStockThemeFeatures(featureDb.db, featureRows)

  assert(themeDb.batchSizes.join(',') === '50,50,21', 'theme_signals upsert must chunk D1 batches')
  assert(featureDb.batchSizes.join(',') === '50,50,21', 'stock_theme_features upsert must chunk D1 batches')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
