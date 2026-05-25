import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/marketRegimeFactorPacket.ts', 'utf8')

for (const text of [
  'latestSourceQualityRow',
  'businessCycleContextWithFallback',
  'macroLiquidityContextWithFallback',
  'globalRiskContextWithFallback',
  'regimeEvidenceItem',
  'regime_evidence?.evidence?.[key]',
  'canonicalInstitutionalDailyAmount',
  'legacyLeverageStress',
  "dataset = ?",
  "WHERE as_of_date <= ?",
  'tw_business_indicators',
  'tw_monetary_aggregates',
  'global_context',
  'canonical_institutional_amount_daily',
  'institutional_investors_trading_all_market_summary',
  'source_quality_metrics',
  'globalRiskDisplayValue',
  '官方當日成交金額',
  'source_quality_metrics.history',
]) {
  assert(source.includes(text), `market regime factor packet should include FinLab fallback path: ${text}`)
}

assert(
  source.includes('FinLab source_quality'),
  'FinLab fallback values should be visible in factor detail text',
)
assert(
  source.includes("source: 'finlab.tw_monetary_aggregates'"),
  'macro liquidity fallback should expose FinLab monetary aggregate source',
)
assert(
  source.includes("source: 'finlab.global_context'"),
  'global risk fallback should expose FinLab global context source',
)
assert(
  source.includes("'canonical_institutional_amount_daily.finlab_daily_official_amount'") &&
    source.includes("'margin_data.legacy_margin_short_amount'"),
  'chip tile should use official FinLab daily amount while leverage can still use fresh legacy margin tables when canonical_chip_daily is stale',
)
assert(
  source.includes('canonical_chip_daily.target_margin_missing') &&
    source.includes('target canonical_chip_daily rows exist but margin/short are empty'),
  'leverage tile should fallback to fresh margin_data when target-date canonical_chip_daily rows exist but margin/short fields are empty',
)
