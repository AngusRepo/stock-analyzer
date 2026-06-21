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
  block.includes("source = 'finlab.fundamental_factor_diversity'") && block.includes('AND (${nonNullPredicate})'),
  'fundamental raw-signal loader should read FinLab canonical fundamentals with non-null field pruning',
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
