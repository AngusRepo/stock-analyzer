import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const monitor = readFileSync('src/lib/dataQualityMonitor.ts', 'utf8')

assert(
  monitor.includes('buildMarketDashboardMaterializationCheck'),
  'data quality monitor should build a dedicated homepage market materialization check',
)
assert(
  monitor.includes("id: 'market_dashboard_materialization'"),
  'data quality monitor should expose market_dashboard_materialization check id',
)
for (const source of [
  'canonical_market_daily',
  'canonical_market_index_daily',
  'canonical_futures_daily',
  'canonical_market_summary_daily',
  'canonical_institutional_amount_daily',
  'canonical_regime_context_daily',
  'external_evidence_items',
]) {
  assert(monitor.includes(source), `market dashboard materialization must audit ${source}`)
}
for (const dataset of [
  'tw_option_put_call_ratio',
  'tw_taifex_futures_large_trader',
  'tw_business_indicators',
  'gdelt_events',
]) {
  assert(monitor.includes(dataset), `market dashboard materialization must audit ${dataset}`)
}
