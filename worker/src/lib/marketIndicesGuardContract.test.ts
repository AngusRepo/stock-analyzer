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
  source.includes('market:indices:finlab-clean:v9-delta-fill'),
  'market indices cache key should be bumped for delta-fill guard',
)
assert(
  source.includes('close > 1000 AND close < 100000'),
  'TWII canonical query should reject score-like bad index values',
)
assert(
  source.includes("session = 'day'") && source.includes("SELECT date, close FROM canonical_futures_daily"),
  'TXF day canonical query should use the explicit day session instead of requiring open_interest history',
)
