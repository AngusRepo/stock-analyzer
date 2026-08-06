import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync(join(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
const start = source.indexOf('async function loadStrategyRawFundamentalSignals')
const end = source.indexOf('async function loadStrategyRawSectorRotationSignals', start)
assert(start >= 0 && end > start, 'loadStrategyRawFundamentalSignals block should exist')

const block = source.slice(start, end)

assert(
  block.includes('canonicalRowsScanned') && source.includes('fieldCoverage') && source.includes('sourceCoverage'),
  'fundamental raw-signal loader should emit coverage telemetry for FinLab field ingestion',
)
assert(
  !block.includes('SELECT MAX(f2.available_date)'),
  'fundamental raw-signal loader must not select one latest row because daily valuation rows can null out ROE/EPS/revenue',
)
assert(
  block.includes('ORDER BY stock_id, available_date DESC, period DESC'),
  'fundamental raw-signal loader should scan newest canonical rows first and merge latest non-null values per field',
)
assert(
  block.includes("source IN ('finlab.fundamental_factor_diversity', 'finlab.daily_valuation')") &&
    block.includes('AND (${nonNullPredicate})'),
  'fundamental raw-signal loader should merge deadline financials and daily valuation with non-null field pruning',
)
assert(
  block.includes('AND available_date <= ?') &&
    block.includes('AND as_of_date <= ?') &&
    block.includes("source = 'finlab.daily_valuation' AND available_date = ?") &&
    block.includes('bind(...chunk, endDate, endDate, endDate)'),
  'historical screener fundamentals must use PIT financial statements but require exact-date daily valuation',
)

const updateOrchestrator = readFileSync(join(process.cwd(), 'src/lib/updateOrchestrator.ts'), 'utf8')
assert(
  updateOrchestrator.includes('sourceKeyCanonicalParityReadiness') &&
    updateOrchestrator.includes("source='finlab.daily_valuation' AND pe IS NOT NULL") &&
    updateOrchestrator.includes("source='finlab.daily_valuation' AND pb IS NOT NULL"),
  'daily valuation readiness must compare FinLab raw target rows with exact canonical PE/PB rows',
)
assert(
  (updateOrchestrator.includes('available_date = ? AND as_of_date <= ?') || updateOrchestrator.includes('available_date=? AND as_of_date<=?')) &&
    updateOrchestrator.includes('AND f.as_of_date <= ?'),
  'FinLab readiness and legacy mirror must not admit rows materialized after the target date',
)
assert(
  block.includes('const patch: StrategyRawFundamentalSignals = { source: row.source }'),
  'raw fundamental evidence must retain the canonical row owner instead of relabeling valuation as fundamental features',
)

for (const field of [
  'revenue_growth_yoy',
  'gross_margin',
  'operating_margin',
  'roe',
  'eps',
  'pe',
  'pb',
  'dividend_yield',
]) {
  assert(
    block.includes(field),
    `fundamental raw-signal loader should request latest non-null ${field}`,
  )
}

assert(
  block.includes('telemetry.canonicalErrors.push') && block.includes('telemetry.revenueErrors.push'),
  'fundamental raw-signal loader should record D1/FinLab ingestion errors instead of silently swallowing them',
)
assert(
  source.includes('fundamental_loader_error') && source.includes('l0RawSignalCoverageAudit'),
  'screener funnel metadata should expose fundamental_loader_error and L0 raw-signal coverage audit',
)
assert(
  !source.includes('Direct financial quality bonus') &&
    !source.includes('FinLab fundamental quality direct-field bonus') &&
    !source.includes('fscoreApplied'),
  'Worker screener must not keep a separate fundamental scoring owner; Score V2 fundamentalQuality owns fundamental points',
)
assert(
  !block.includes('catch {\n      // Older local D1 snapshots may not have canonical_fundamental_features.'),
  'canonical fundamental loader must not silently swallow missing-table or query errors',
)

const normalizationStart = source.indexOf('function applyFinLabStyleFactorNormalization')
const normalizationEnd = source.indexOf('function calcMarketReturn5d', normalizationStart)
assert(normalizationStart >= 0 && normalizationEnd > normalizationStart, 'FinLab-style factor normalization helper should exist')
const normalizationBlock = source.slice(normalizationStart, normalizationEnd)
assert(
  normalizationBlock.includes("method: 'finlab_style_cs_sector_rank_zscore_winsor_sector_neutral_v2'"),
  'FinLab-style normalization should be versioned for L0/L1.25 evidence audits',
)
assert(
  normalizationBlock.includes('zScoreKey') &&
    normalizationBlock.includes('winsorizedKey') &&
    normalizationBlock.includes('sectorNeutralRankKey') &&
  normalizationBlock.includes('finlabInverseVolatilityWeight') &&
  normalizationBlock.includes('finlabIndustryCapWeight') &&
  normalizationBlock.includes('finlabTurnoverControlWeight'),
  'FinLab-style normalization should expose z-score, winsorized, sector-neutral, inverse-vol, industry-cap, and turnover-control evidence',
)
assert(
  source.includes("rawField: 'vwapBias'") &&
    source.includes("rawField: 'vwapBias5d'") &&
    source.includes('vwap_bias') &&
    source.includes('vwap_bias_5d'),
  'daily VWAP should be materialized as raw evidence and normalized ranks without touching intraday execution gates',
)
assert(
  normalizationBlock.includes('finlabQualityCompositeRank') &&
    normalizationBlock.includes('finlabValueCompositeRank') &&
  normalizationBlock.includes('finlabSectorQualityCompositeRank'),
  'FinLab-style normalization should expose quality/value/sector-relative composite evidence',
)
assert(
  normalizationBlock.includes('formal137MarginBalanceRank') &&
  normalizationBlock.includes('margin_balance_rank') &&
  normalizationBlock.includes('margin_balance_normalized'),
  'FinLab-style normalization should expose normalized margin-balance aliases for formal137 strategy specs',
)
assert(
  normalizationBlock.includes('raw.factorSignals') &&
  !normalizationBlock.includes('.score +=') &&
  !normalizationBlock.includes('.score -='),
  'FinLab-style normalization must write evidence only, not act as a selector or score override',
)
