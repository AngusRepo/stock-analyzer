import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/lib/marketRisk.ts', 'utf8')

assert(
  source.includes('FROM canonical_market_index_daily'),
  'market risk TWII history must come from canonical_market_index_daily',
)

assert(
  source.includes("source === 'finlab.taiex_total_index'"),
  'market risk TWII history must prefer FinLab taiex_total_index rows',
)

assert(
  source.includes('AND date <= ?'),
  'market risk TWII history must use the latest available trading day at or before runDate',
)

assert(
  source.includes("source != 'finlab.benchmark_return'"),
  'market risk TWII history must never use the total-return benchmark as the TWII price index',
)

assert(
  source.includes('fetchTwseOfficialTwiiHistory') && source.includes('MI_5MINS_HIST'),
  'market risk TWII history should use TWSE official TAIEX history only when canonical history is too short',
)

assert(
  source.includes('if (byDate.size < 21)'),
  'market risk TWII official fallback should only run when the canonical 20-day window is incomplete',
)

assert(
  !source.includes('finance/chart/%5ETWII'),
  'market risk TWII history must not use Yahoo ^TWII live chart data',
)
