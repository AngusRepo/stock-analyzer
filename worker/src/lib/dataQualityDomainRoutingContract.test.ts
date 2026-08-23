import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const monitor = readFileSync('src/lib/dataQualityMonitor.ts', 'utf8')

assert.doesNotMatch(
  monitor,
  /\benv\.DB\b/,
  'Data Quality must not read the stale legacy D1 after all seven production domains cut over',
)

for (const [name, domain] of [
  ['coreDb', 'core'],
  ['marketDb', 'market'],
  ['learningDb', 'learning'],
  ['opsDb', 'ops'],
  ['paperDb', 'paper'],
] as const) {
  assert.match(
    monitor,
    new RegExp(`const ${name} = databaseForDataDomain\\(env, '${domain}'\\)`),
    `Data Quality must resolve the formal ${domain} D1 owner`,
  )
}

assert.match(
  monitor,
  /loadClassificationStats\(coreDb, marketDb, targetDate\)/,
  'recommendation classification must merge Core recommendations with Market taxonomy in TypeScript',
)
assert.match(
  monitor,
  /loadPendingBuyStats\(coreDb, paperDb, targetDate\)/,
  'pending-buy ownership must merge Paper items with Core recommendations in TypeScript',
)
assert.match(
  monitor,
  /loadBoardLaneStats\(coreDb, marketDb, paperDb, targetDate\)/,
  'board-lane validation must merge Core, Market, and Paper evidence in TypeScript',
)
assert.match(
  monitor,
  /for \(let offset = 0; offset < uniqueIds\.length; offset \+= 90\)/,
  'as-of Market price hydration must remain below the D1 100-bind limit',
)
assert.match(
  monitor,
  /firstCount\(\s*opsDb,\s*`SELECT run_id AS funnel_run_id/,
  'screener funnel truth must read the Ops D1 owner',
)
for (const table of [
  'stock_prices',
  'chip_data',
  'technical_indicators',
  'sector_flow',
  'theme_signals',
  'stock_theme_features',
  'canonical_market_daily',
  'external_evidence_items',
  'source_quality_metrics',
]) {
  assert.match(monitor, new RegExp(`\\b${table}\\b`), `Data Quality must retain the ${table} check`)
}

console.log('data quality domain routing contract passed')
