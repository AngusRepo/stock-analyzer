import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/routes/other.ts', 'utf8')

assert(
  source.includes('fetchTwseTaiexOfficialSeries'),
  'market indices should have an official TWSE TAIEX fallback',
)
assert(
  source.includes('MI_5MINS_HIST'),
  'TAIEX fallback should use TWSE official MI_5MINS_HIST',
)
assert(
  source.includes('market:indices:finlab-clean:v17-taifex-controller-live-night'),
  'market indices cache key should be bumped for TWII canonical date fallback',
)
assert(
  source.includes('close > 1000') && source.includes('close < 100000'),
  'TWII canonical query should reject score-like bad index values',
)
assert(
  source.includes("source IN ('finlab.taiex_total_index', 'twse.mi_5mins_hist.official')"),
  'TWII canonical query must include FinLab primary rows and TWSE official canonical date fallback rows',
)
assert(
  source.includes('twiiCanonicalSourceRank') &&
    source.includes("source === 'finlab.taiex_total_index'") &&
    source.includes("source === 'twse.mi_5mins_hist.official'"),
  'TWII same-date canonical dedupe must prefer FinLab over TWSE official fallback',
)
assert(
  !source.includes('benchmark_return:發行量加權股價報酬指數') &&
    !source.includes('FinLab finlab_benchmark_return'),
  'TWII market index candidates must not use the total-return benchmark as price index close',
)
assert(
  source.includes('const twii = chooseBestMarketSeries(canonicalTwii, [twseOfficialTwii])'),
  'TWII market index serving must choose the latest canonical date before falling back to live TWSE official fetch',
)
assert(
  !source.includes('chooseBestMarketSeries(finlabTwii, [marketRiskTwii])'),
  'market_risk.twii_close must not override canonical_market_index_daily for TWII price-index serving',
)
assert(
  source.includes("session = 'day'") && source.includes("SELECT date, close FROM canonical_futures_daily"),
  'TXF day canonical query should use the explicit day session instead of requiring open_interest history',
)
assert(
  source.includes("session = 'night'") && source.includes('canonicalNightFallback'),
  'TXF night should fall back to canonical_futures_daily night when TAIFEX live night is unavailable',
)

assert(
  source.includes('marketSeriesFreshnessRank') && source.includes("source.includes('TAIFEX MIS')"),
  'TXF same-date selection must prefer TAIFEX MIS live quotes over canonical futures snapshots',
)
