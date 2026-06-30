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
  source.includes('market:indices:finlab-clean:v8-official-index-guard'),
  'market indices cache key should be bumped for official index guard',
)
assert(
  source.includes('close > 1000 AND close < 100000'),
  'TWII canonical query should reject score-like bad index values',
)
assert(
  source.includes('open_interest IS NOT NULL'),
  'TXF day canonical query should reject after-hours rows that overwrote day rows without open interest',
)
