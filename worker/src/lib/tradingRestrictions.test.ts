import { readFileSync } from 'node:fs'
import { finlabTradingRestrictionCutoff } from './tradingRestrictions'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(
  finlabTradingRestrictionCutoff('2026-05-19') === '2026-04-18',
  'FinLab trading restrictions should keep about one month, not 180 days',
)

const source = readFileSync('src/lib/tradingRestrictions.ts', 'utf8')
assert(
  source.includes("source != 'finlab.trading_attention' OR source_date >= ?"),
  'runtime restriction loader must ignore stale FinLab trading_attention rows even before D1 cleanup',
)
assert(
  source.includes('const canonicalFresh = Boolean(canonical.latestSourceDate && canonical.latestSourceDate >= tradeDate)') &&
    source.includes('options.refreshOfficialIfStale && stale && !canonicalFresh'),
  'official trading restriction refresh should be fallback-only when FinLab canonical restrictions are fresh',
)
