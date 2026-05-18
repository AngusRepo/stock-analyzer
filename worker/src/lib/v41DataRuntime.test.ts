import { buildFinLabTaxonomyThemeSignals, buildStockThemeFeatureRows, buildV41SourceCoverageRows } from './v41DataRuntime'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const features = buildStockThemeFeatureRows(
  [
    {
      date: '2026-05-15',
      concept: 'AI_Server',
      source: 'finnhub_news',
      score: 0.8,
      sentiment_avg: 0.1,
      evidence_count: 2,
      top_titles: JSON.stringify(['finnhub headline']),
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
assert(JSON.parse(tsmcAi?.source_breakdown_json ?? '{}').finnhub_news === 0.8, 'source breakdown must preserve Finnhub contribution')
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
    { source: 'finnhub', rows: 3, latest_published_at: '2026-05-18T06:00:00+08:00', entity_link_confidence: 0.82 },
  ],
})
const finlabCoverage = sourceCoverage.find(row => row.source === 'finlab')
const gdeltCoverage = sourceCoverage.find(row => row.source === 'gdelt_events')
const finnhubCoverage = sourceCoverage.find(row => row.source === 'finnhub_news')
assert(finlabCoverage?.rows === 12, 'FinLab taxonomy should roll into FinLab source coverage')
assert(finlabCoverage?.runtime_state === 'production', 'FinLab non-empty coverage should be production runtime')
assert(finnhubCoverage?.rows === 3, 'Finnhub evidence rows should be visible in source coverage')
assert(finnhubCoverage?.entity_link_confidence === 0.82, 'source coverage must expose entity-link confidence')
assert(gdeltCoverage?.runtime_state === 'missing', 'missing formal-shadow GDELT should be fail-visible, not invisible')
