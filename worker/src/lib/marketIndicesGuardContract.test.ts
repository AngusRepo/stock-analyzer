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
  source.includes('market:indices:finlab-clean:v12-twii-finlab-first'),
  'market indices cache key should be bumped for FinLab taiex_total_index guard',
)
assert(
  source.includes('close > 1000 AND close < 100000'),
  'TWII canonical query should reject score-like bad index values',
)
assert(
  !source.includes('benchmark_return:發行量加權股價報酬指數') &&
    !source.includes('FinLab finlab_benchmark_return'),
  'TWII market index candidates must not use the total-return benchmark as price index close',
)
assert(
  source.includes('const twii = hasMarketSeriesData(finlabTwii)') &&
    source.includes('? finlabTwii') &&
    source.includes(': hasMarketSeriesData(marketRiskTwii)') &&
    source.includes('? marketRiskTwii') &&
    source.includes(': twseOfficialTwii'),
  'TWII market index serving must prefer FinLab canonical and market_risk rows before official fallback even when official is newer',
)
assert(
  source.includes("session = 'day'") && source.includes("SELECT date, close FROM canonical_futures_daily"),
  'TXF day canonical query should use the explicit day session instead of requiring open_interest history',
)
assert(
  source.includes("session = 'night'") && source.includes('canonicalNightFallback'),
  'TXF night should fall back to canonical_futures_daily night when TAIFEX live night is unavailable',
)
