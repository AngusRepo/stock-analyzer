import { readFileSync } from 'node:fs'
import type { Bindings } from '../types'
import {
  assertTradingRestrictionPromotionAuthority,
  finlabTradingRestrictionCutoff,
  loadTradingRestrictionBuckets,
} from './tradingRestrictions'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(
  finlabTradingRestrictionCutoff('2026-05-19') === '2026-04-18',
  'FinLab trading restrictions should keep about one month, not 180 days',
)

const source = readFileSync('src/lib/tradingRestrictions.ts', 'utf8')
const twseApi = readFileSync('src/lib/twseApi.ts', 'utf8')
const marketScreener = readFileSync('src/lib/marketScreener.ts', 'utf8')
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
assert(
  source.includes('official_trading_restrictions_incomplete:') &&
    source.includes("status: 'error'") &&
    source.includes("status: 'success'"),
  'official restriction readiness must fail closed unless all four sources complete',
)
assert(
  source.includes('async function reconcileOfficialRestrictions') &&
    source.includes("end_date = date(?, '-1 day')") &&
    source.includes('await reconcileOfficialRestrictions') &&
    !source.includes('if (!symbols.length) return'),
  'daily official snapshots must expire prior active rows even when the current source list is empty',
)
assert(
  marketScreener.includes('evidenceMode: StrategyEvidenceMode') &&
    marketScreener.includes('evidenceMode,') &&
    marketScreener.includes('evidence_status: restricted.evidenceStatus') &&
    marketScreener.includes('assertTradingRestrictionPromotionAuthority(runDate, restricted.evidenceStatus)'),
  'market screener must pass the run evidence mode and fail closed before historical UNKNOWN_LEGACY evidence becomes formal output',
)


interface RestrictionMockOptions {
  failD1?: boolean
  kvValues?: Record<string, unknown>
  historicalRows?: boolean
}

function restrictionMockEnv(options: RestrictionMockOptions = {}): {
  env: Bindings
  sql: string[]
  kvReads: string[]
} {
  const sql: string[] = []
  const kvReads: string[] = []
  const db = {
    prepare(statement: string) {
      sql.push(statement)
      return {
        bind(..._values: unknown[]) {
          return {
            async all() {
              if (options.failD1) throw new Error('d1 unavailable')
              if (!options.historicalRows) return { results: [] }
              if (statement.includes('canonical_trading_restrictions') && statement.includes('MAX(source_date)')) {
                return {
                  results: [{
                    symbol: '6586',
                    source: 'official.twse_punish',
                    latest_source_date: '2026-05-12',
                  }],
                }
              }
              if (statement.includes('canonical_trading_restrictions')) {
                return {
                  results: [{
                    symbol: '6586',
                    restriction_type: 'disposition',
                    source: 'official.twse_punish',
                  }],
                }
              }
              if (statement.includes('stock_trading_restrictions') && statement.includes('restriction_type')) {
                return { results: [] }
              }
              if (statement.includes('stock_trading_restrictions')) {
                return { results: [{ symbol: '1234' }] }
              }
              return { results: [] }
            },
          }
        },
      }
    },
  }
  const kv = {
    async get(key: string, _type?: string) {
      kvReads.push(key)
      return options.kvValues?.[key] ?? null
    },
    async put() {},
  }
  return { env: { DB: db, KV: kv } as unknown as Bindings, sql, kvReads }
}

async function runBehaviorTests(): Promise<void> {
  const historical = restrictionMockEnv({ historicalRows: true })
  const historicalBuckets = await loadTradingRestrictionBuckets(historical.env, '2026-05-12', {
    evidenceMode: 'historical_replay',
    refreshOfficialIfStale: true,
  })
  assert(historical.kvReads.length === 0, 'historical replay must make zero current-KV reads')
  assert(
    historical.sql.every((statement) => !statement.includes('COALESCE(active, 1) = 1')),
    'historical replay must not use the current active flag as historical truth',
  )
  assert(
    historical.sql.filter((statement) => statement.includes('canonical_trading_restrictions'))
      .every((statement) => statement.includes('date(source_date) <= date(?)')),
    'historical canonical diagnostics must reject rows whose effective source_date is after the replay date',
  )
  assert(
    historicalBuckets.hardBlockedSymbols.has('6586'),
    'an interval-valid historical disposition must remain a diagnostic hard hit even when its current active flag is stale/zero',
  )
  assert(historicalBuckets.riskEvidenceSymbols.has('1234'), 'historical governance interval rows must remain diagnostic evidence')
  assert(historicalBuckets.evidenceStatus.authority === 'UNKNOWN_LEGACY', 'legacy historical restriction authority must be explicit')
  assert(historicalBuckets.evidenceStatus.completeness === 'DATA_BLOCKED', 'legacy historical restriction evidence must be data-blocked')
  assert(!historicalBuckets.evidenceStatus.promotionEligible, 'UNKNOWN_LEGACY evidence must not be promotion eligible')
  let authorityBlock = ''
  try {
    assertTradingRestrictionPromotionAuthority('2026-05-12', historicalBuckets.evidenceStatus)
  } catch (error) {
    authorityBlock = String(error)
  }
  assert(
    authorityBlock.includes('trading_restriction_pit_authority_blocked') && authorityBlock.includes('UNKNOWN_LEGACY'),
    'formal historical screener run must fail closed on UNKNOWN_LEGACY restriction authority',
  )

  const live = restrictionMockEnv({
    failD1: true,
    kvValues: {
      'market:punished_stocks': ['1111'],
      'market:attention_stocks': ['2222'],
      'market:tpex_punished_stocks': [{ symbol: '3333' }],
      'market:tpex_attention_stocks': [{ code: '4444' }],
      'market:delisting_risk': ['5555'],
      'market:trading_restrictions:checked_at': new Date().toISOString(),
    },
  })
  const liveBuckets = await loadTradingRestrictionBuckets(live.env, '2026-08-15', {
    evidenceMode: 'live_current',
  })
  for (const symbol of ['1111', '3333', '5555']) {
    assert(liveBuckets.hardBlockedSymbols.has(symbol), `live D1 failure must hard-block KV safety symbol ${symbol}`)
  }
  for (const symbol of ['2222', '4444']) {
    assert(liveBuckets.riskEvidenceSymbols.has(symbol), `live attention/notice ${symbol} must remain risk evidence`)
    assert(!liveBuckets.hardBlockedSymbols.has(symbol), `live attention/notice ${symbol} must remain soft`)
  }
  assert(
    liveBuckets.evidenceStatus.completeness === 'DEGRADED_KV_FALLBACK' && !liveBuckets.evidenceStatus.promotionEligible,
    'live D1 failure must expose degraded safety fallback and remain ineligible as formal promotion evidence',
  )
}

runBehaviorTests().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
