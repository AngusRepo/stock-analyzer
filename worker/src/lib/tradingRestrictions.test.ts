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
const twseApi = readFileSync('src/lib/twseApi.ts', 'utf8')
assert(
  source.includes("source != 'finlab.trading_attention' OR source_date >= ?"),
  'runtime restriction loader must ignore stale FinLab trading_attention rows even before D1 cleanup',
)
assert(
  source.includes('const canonicalFresh = Boolean(canonical.latestSourceDate && canonical.latestSourceDate >= tradeDate)') &&
    source.includes('options.refreshOfficialIfStale && stale && !canonicalFresh'),
  'official trading restriction refresh should be fallback-only when FinLab canonical restrictions are fresh',
)
assert(
  source.includes("normalizedType === 'attention'") &&
    source.includes("normalizedSource.includes('notice')) return false"),
  'attention stocks must stay soft risk evidence',
)
assert(
  source.includes("normalizedType === 'disposition'") &&
    source.includes("normalizedSource.includes('punish')") &&
    source.includes("normalizedSource.includes('disposition')) return true"),
  'disposition/punish stocks must be L0 hard blocks',
)
assert(
  source.includes('fetchTpexPunishedStocks') &&
    source.includes('fetchTpexAttentionStocks') &&
    source.includes("counts['official.tpex_punish']") &&
    source.includes("counts['official.tpex_notice']") &&
    source.includes("market:tpex_punished_stocks") &&
    source.includes("market:tpex_attention_stocks"),
  'official trading restriction fallback must include TPEX attention/disposition, not only TWSE',
)
assert(
  twseApi.includes('tpex_trading_warning_information') &&
    twseApi.includes('tpex_disposal_information') &&
    twseApi.includes('SecuritiesCompanyCode'),
  'TPEX official restriction fetchers must use official openapi endpoints and parse SecuritiesCompanyCode',
)
