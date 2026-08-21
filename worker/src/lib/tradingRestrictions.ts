import { databaseForDataDomain } from './dataDomainRegistry'
import type { Bindings } from '../types'
import { fetchAttentionStocks, fetchPunishedStocks, fetchTpexAttentionStocks, fetchTpexPunishedStocks } from './twseApi'

export type TradingRestrictionSource =
  | 'finlab.trading_attention'
  | 'official.twse_notice'
  | 'official.twse_punish'
  | 'official.tpex_notice'
  | 'official.tpex_punish'
  | 'stock_trading_restrictions'
  | 'kv_fallback'

export interface TradingRestrictionSet {
  symbols: Set<string>
  sourceCounts: Record<string, number>
  freshness: {
    canonicalLatestSourceDate: string | null
    officialCheckedAt: string | null
  }
  evidenceStatus: TradingRestrictionEvidenceStatus
}

export type TradingRestrictionEvidenceMode = 'live_current' | 'historical_replay'
export type TradingRestrictionEvidenceAuthority = 'LIVE_CURRENT' | 'UNKNOWN_LEGACY'
export type TradingRestrictionEvidenceCompleteness = 'COMPLETE' | 'DEGRADED_KV_FALLBACK' | 'DATA_BLOCKED'

export interface TradingRestrictionEvidenceStatus {
  evidenceMode: TradingRestrictionEvidenceMode
  authority: TradingRestrictionEvidenceAuthority
  completeness: TradingRestrictionEvidenceCompleteness
  promotionEligible: boolean
  reason: string | null
}

export interface TradingRestrictionLoadOptions {
  refreshOfficialIfStale?: boolean
  refreshTtlMs?: number
  evidenceMode?: TradingRestrictionEvidenceMode
}

export interface TradingRestrictionBuckets {
  hardBlockedSymbols: Set<string>
  riskEvidenceSymbols: Set<string>
  sourceCounts: Record<string, number>
  hardSourceCounts: Record<string, number>
  freshness: TradingRestrictionSet['freshness']
  evidenceStatus: TradingRestrictionEvidenceStatus
}

interface RestrictionQueryResult<T> {
  value: T
  querySucceeded: boolean
}

interface CurrentKvRestrictions {
  punished: string[]
  attention: string[]
  tpexPunished: string[]
  tpexAttention: string[]
  delisting: string[]
  checkedAt: string | null
}

const FINLAB_TRADING_RESTRICTION_RETENTION_DAYS = 31
const HARD_RESTRICTION_TYPES = new Set([
  'delisting',
  'suspended',
  'halted',
  'untradable',
  'data_untrusted',
  'execution_block',
])

function isHardRestrictionType(type: unknown, source: unknown): boolean {
  const normalizedType = String(type ?? '').trim().toLowerCase()
  const normalizedSource = String(source ?? '').trim().toLowerCase()
  if (HARD_RESTRICTION_TYPES.has(normalizedType)) return true
  if (normalizedType === 'attention' || normalizedSource.includes('attention') || normalizedSource.includes('notice')) return false
  if (normalizedType === 'disposition' || normalizedSource.includes('punish') || normalizedSource.includes('disposition')) return true
  return false
}

function addSourceCount(counts: Record<string, number>, source: string, amount = 1): void {
  counts[source] = (counts[source] ?? 0) + amount
}

function isoDateDaysAgo(tradeDate: string, days: number): string {
  const base = new Date(`${tradeDate}T00:00:00.000Z`)
  const validBase = Number.isFinite(base.getTime()) ? base : new Date()
  validBase.setUTCDate(validBase.getUTCDate() - days)
  return validBase.toISOString().slice(0, 10)
}

export function finlabTradingRestrictionCutoff(tradeDate: string): string {
  return isoDateDaysAgo(tradeDate, FINLAB_TRADING_RESTRICTION_RETENTION_DAYS)
}

function cleanSymbol(value: unknown): string {
  const m = String(value ?? '').match(/\b(\d{4,6})\b/)
  return m?.[1] ?? ''
}

async function readSymbolList(kv: KVNamespace, key: string): Promise<string[]> {
  try {
    const value = await kv.get(key, 'json') as unknown
    return Array.isArray(value)
      ? value.map((item) => cleanSymbol(typeof item === 'string' ? item : (item as any)?.symbol ?? (item as any)?.code)).filter(Boolean)
      : []
  } catch {
    return []
  }
}

async function loadCanonicalRestrictions(
  db: D1Database,
  tradeDate: string,
  evidenceMode: TradingRestrictionEvidenceMode,
): Promise<RestrictionQueryResult<{ symbols: string[]; sourceCounts: Record<string, number>; latestSourceDate: string | null }>> {
  try {
    const finlabCutoff = finlabTradingRestrictionCutoff(tradeDate)
    const activeClause = evidenceMode === 'live_current' ? 'AND COALESCE(active, 1) = 1' : ''
    const historicalSourceDateClause = evidenceMode === 'historical_replay'
      ? 'AND date(source_date) <= date(?)'
      : ''
    const bindValues = evidenceMode === 'historical_replay'
      ? [tradeDate, tradeDate, finlabCutoff, tradeDate]
      : [tradeDate, tradeDate, finlabCutoff]

    const { results } = await db.prepare(`
      SELECT symbol, source, MAX(source_date) AS latest_source_date
        FROM canonical_trading_restrictions
       WHERE 1 = 1
         ${activeClause}
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND (source != 'finlab.trading_attention' OR source_date >= ?)
         ${historicalSourceDateClause}
       GROUP BY symbol, source
    `).bind(...bindValues).all<{ symbol: string | null; source: string | null; latest_source_date: string | null }>()
    const counts: Record<string, number> = {}
    let latest: string | null = null
    const symbols: string[] = []
    for (const row of results ?? []) {
      const symbol = cleanSymbol(row.symbol)
      if (!symbol) continue
      symbols.push(symbol)
      addSourceCount(counts, row.source || 'canonical_trading_restrictions')
      if (row.latest_source_date && (!latest || row.latest_source_date > latest)) latest = row.latest_source_date
    }
    return { value: { symbols, sourceCounts: counts, latestSourceDate: latest }, querySucceeded: true }
  } catch {
    return { value: { symbols: [], sourceCounts: {}, latestSourceDate: null }, querySucceeded: false }
  }
}

async function loadGovernanceRestrictions(
  db: D1Database,
  tradeDate: string,
  evidenceMode: TradingRestrictionEvidenceMode,
): Promise<RestrictionQueryResult<string[]>> {
  try {
    const activeClause = evidenceMode === 'live_current' ? 'AND COALESCE(active, 1) = 1' : ''
    const { results } = await db.prepare(`
      SELECT symbol
        FROM stock_trading_restrictions
       WHERE 1 = 1
         ${activeClause}
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
    `).bind(tradeDate, tradeDate).all<{ symbol: string | null }>()
    return {
      value: (results ?? []).map((row) => cleanSymbol(row.symbol)).filter(Boolean),
      querySucceeded: true,
    }
  } catch {
    return { value: [], querySucceeded: false }
  }
}

async function loadCurrentKvRestrictions(kv: KVNamespace): Promise<CurrentKvRestrictions> {
  const [punished, attention, tpexPunished, tpexAttention, delisting, checkedAt] = await Promise.all([
    readSymbolList(kv, 'market:punished_stocks'),
    readSymbolList(kv, 'market:attention_stocks'),
    readSymbolList(kv, 'market:tpex_punished_stocks'),
    readSymbolList(kv, 'market:tpex_attention_stocks'),
    readSymbolList(kv, 'market:delisting_risk'),
    kv.get('market:trading_restrictions:checked_at').catch(() => null),
  ])
  return { punished, attention, tpexPunished, tpexAttention, delisting, checkedAt }
}

function restrictionEvidenceStatus(
  evidenceMode: TradingRestrictionEvidenceMode,
  d1Complete: boolean,
): TradingRestrictionEvidenceStatus {
  if (evidenceMode === 'historical_replay') {
    return {
      evidenceMode,
      authority: 'UNKNOWN_LEGACY',
      completeness: 'DATA_BLOCKED',
      promotionEligible: false,
      reason: 'historical_restriction_rows_lack_verified_available_at_or_append_only_revision_lineage',
    }
  }
  if (!d1Complete) {
    return {
      evidenceMode,
      authority: 'LIVE_CURRENT',
      completeness: 'DEGRADED_KV_FALLBACK',
      promotionEligible: false,
      reason: 'live_restriction_d1_incomplete_using_current_kv_safety_fallback',
    }
  }
  return {
    evidenceMode,
    authority: 'LIVE_CURRENT',
    completeness: 'COMPLETE',
    promotionEligible: true,
    reason: null,
  }
}

export function assertTradingRestrictionPromotionAuthority(
  tradeDate: string,
  status: TradingRestrictionEvidenceStatus,
): void {
  if (status.evidenceMode !== 'historical_replay' || status.promotionEligible) return
  throw new Error(
    `trading_restriction_pit_authority_blocked:run_date=${tradeDate}:authority=${status.authority}:completeness=${status.completeness}:reason=${status.reason ?? 'unknown'}`,
  )
}

async function reconcileOfficialRestrictions(
  env: Bindings,
  tradeDate: string,
  type: 'attention' | 'disposition',
  symbols: string[],
  market: 'LISTED' | 'OTC' = 'LISTED',
): Promise<void> {
  const isTpex = market === 'OTC'
  const source = type === 'attention'
    ? (isTpex ? 'official.tpex_notice' : 'official.twse_notice')
    : (isTpex ? 'official.tpex_punish' : 'official.twse_punish')
  const sourceUrl = type === 'attention'
    ? (isTpex
        ? 'https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information'
        : 'https://www.twse.com.tw/rwd/zh/announcement/notice?response=json')
    : (isTpex
        ? 'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information'
        : 'https://www.twse.com.tw/rwd/zh/announcement/punish?response=json')
  const marketDb = databaseForDataDomain(env, 'market')
  const statements = [marketDb.prepare(`
    UPDATE canonical_trading_restrictions
       SET active = 0,
           end_date = date(?, '-1 day'),
           updated_at = CURRENT_TIMESTAMP
     WHERE source = ?
       AND COALESCE(active, 1) = 1
       AND date(source_date) < date(?)
  `).bind(tradeDate, source, tradeDate), ...symbols.map((symbol) => marketDb.prepare(`
    INSERT INTO canonical_trading_restrictions (
      symbol, restriction_type, market_segment, start_date, end_date, source,
      source_date, title, source_url, lineage_json, active, updated_at
    )
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(symbol, restriction_type, source, source_date) DO UPDATE SET
      market_segment=excluded.market_segment,
      title=excluded.title,
      source_url=excluded.source_url,
      lineage_json=excluded.lineage_json,
      active=excluded.active,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    symbol,
    type,
    market,
    tradeDate,
    source,
    tradeDate,
    `${type}:${symbol}`,
    sourceUrl,
    JSON.stringify({ schema_version: 'canonical-trading-restrictions-v1', source, fetch_mode: 'official_fallback' }),
  ))]
  for (let i = 0; i < statements.length; i += 50) {
    await marketDb.batch(statements.slice(i, i + 50))
  }
}

export async function refreshOfficialTradingRestrictions(env: Bindings, tradeDate: string): Promise<Record<string, number>> {
  const [punishedResult, attentionResult, tpexPunishedResult, tpexAttentionResult] = await Promise.allSettled([
    fetchPunishedStocks(),
    fetchAttentionStocks(),
    fetchTpexPunishedStocks(),
    fetchTpexAttentionStocks(),
  ])
  const outcomes = [
    ['official.twse_punish', punishedResult],
    ['official.twse_notice', attentionResult],
    ['official.tpex_punish', tpexPunishedResult],
    ['official.tpex_notice', tpexAttentionResult],
  ] as const
  const failedSources = outcomes
    .filter(([, result]) => result.status === 'rejected')
    .map(([source, result]) => ({
      source,
      error: result.status === 'rejected' ? String(result.reason) : null,
    }))
  if (failedSources.length > 0) {
    await env.KV.put('market:trading_restrictions:refresh_status', JSON.stringify({
      status: 'error',
      trade_date: tradeDate,
      failed_sources: failedSources,
      checked_at: new Date().toISOString(),
    }), { expirationTtl: 86400 })
    throw new Error(`official_trading_restrictions_incomplete:${failedSources.map((row) => row.source).join(',')}`)
  }

  const counts: Record<string, number> = {}
  if (punishedResult.status === 'fulfilled') {
    await env.KV.put('market:punished_stocks', JSON.stringify(punishedResult.value), { expirationTtl: 86400 })
    counts['official.twse_punish'] = punishedResult.value.length
    await reconcileOfficialRestrictions(env, tradeDate, 'disposition', punishedResult.value, 'LISTED')
  }
  if (attentionResult.status === 'fulfilled') {
    await env.KV.put('market:attention_stocks', JSON.stringify(attentionResult.value), { expirationTtl: 86400 })
    counts['official.twse_notice'] = attentionResult.value.length
    await reconcileOfficialRestrictions(env, tradeDate, 'attention', attentionResult.value, 'LISTED')
  }
  if (tpexPunishedResult.status === 'fulfilled') {
    await env.KV.put('market:tpex_punished_stocks', JSON.stringify(tpexPunishedResult.value), { expirationTtl: 86400 })
    counts['official.tpex_punish'] = tpexPunishedResult.value.length
    await reconcileOfficialRestrictions(env, tradeDate, 'disposition', tpexPunishedResult.value, 'OTC')
  }
  if (tpexAttentionResult.status === 'fulfilled') {
    await env.KV.put('market:tpex_attention_stocks', JSON.stringify(tpexAttentionResult.value), { expirationTtl: 86400 })
    counts['official.tpex_notice'] = tpexAttentionResult.value.length
    await reconcileOfficialRestrictions(env, tradeDate, 'attention', tpexAttentionResult.value, 'OTC')
  }
  const checkedAt = new Date().toISOString()
  await env.KV.put('market:trading_restrictions:refresh_status', JSON.stringify({
    status: 'success',
    trade_date: tradeDate,
    source_counts: counts,
    checked_at: checkedAt,
  }), { expirationTtl: 86400 })
  await env.KV.put('market:restricted_execution_checked_at', new Date().toISOString(), { expirationTtl: 3600 })
  await env.KV.put('market:trading_restrictions:checked_at', checkedAt, { expirationTtl: 86400 })
  return counts
}

export async function loadTradingRestrictionSet(
  env: Bindings,
  tradeDate: string,
  options: TradingRestrictionLoadOptions = {},
): Promise<TradingRestrictionSet> {
  const target = new Set<string>()
  const sourceCounts: Record<string, number> = {}
  const evidenceMode = options.evidenceMode ?? 'live_current'

  const canonicalResult = await loadCanonicalRestrictions(env.DB, tradeDate, evidenceMode)
  const canonical = canonicalResult.value
  for (const symbol of canonical.symbols) target.add(symbol)
  for (const [source, count] of Object.entries(canonical.sourceCounts)) addSourceCount(sourceCounts, source, count)

  const governanceResult = await loadGovernanceRestrictions(env.DB, tradeDate, evidenceMode)
  const governance = governanceResult.value
  for (const symbol of governance) target.add(symbol)
  if (governance.length) addSourceCount(sourceCounts, 'stock_trading_restrictions', governance.length)

  let currentKv: CurrentKvRestrictions | null = null
  if (evidenceMode === 'live_current') {
    currentKv = await loadCurrentKvRestrictions(env.KV)
    const kvRows = [
      ...currentKv.punished,
      ...currentKv.attention,
      ...currentKv.tpexPunished,
      ...currentKv.tpexAttention,
      ...currentKv.delisting,
    ]
    for (const symbol of kvRows) target.add(symbol)
    if (kvRows.length) addSourceCount(sourceCounts, 'kv_fallback', kvRows.length)

    const refreshTtlMs = options.refreshTtlMs ?? 12 * 60 * 60_000
    const checkedAtMs = currentKv.checkedAt ? Date.parse(currentKv.checkedAt) : 0
    const stale = !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > refreshTtlMs
    const canonicalFresh = Boolean(canonical.latestSourceDate && canonical.latestSourceDate >= tradeDate)
    if (options.refreshOfficialIfStale && stale && !canonicalFresh) {
      const officialCounts = await refreshOfficialTradingRestrictions(env, tradeDate).catch(() => ({}))
      for (const [source, count] of Object.entries(officialCounts)) addSourceCount(sourceCounts, source, count)
      currentKv = await loadCurrentKvRestrictions(env.KV)
      for (const symbol of [
        ...currentKv.punished, ...currentKv.attention, ...currentKv.tpexPunished,
        ...currentKv.tpexAttention, ...currentKv.delisting,
      ]) target.add(symbol)
    }
  }

  return {
    symbols: target,
    sourceCounts,
    freshness: {
      canonicalLatestSourceDate: canonical.latestSourceDate,
      officialCheckedAt: currentKv?.checkedAt ?? null,
    },
    evidenceStatus: restrictionEvidenceStatus(evidenceMode, canonicalResult.querySucceeded && governanceResult.querySucceeded),
  }
}

export async function loadTradingRestrictionBuckets(
  env: Bindings,
  tradeDate: string,
  options: TradingRestrictionLoadOptions = {},
): Promise<TradingRestrictionBuckets> {
  const allRestrictions = await loadTradingRestrictionSet(env, tradeDate, options)
  const hardBlockedSymbols = new Set<string>()
  const hardSourceCounts: Record<string, number> = {}
  const finlabCutoff = finlabTradingRestrictionCutoff(tradeDate)
  const evidenceMode = options.evidenceMode ?? 'live_current'
  const activeClause = evidenceMode === 'live_current' ? 'AND COALESCE(active, 1) = 1' : ''
  const historicalSourceDateClause = evidenceMode === 'historical_replay'
    ? 'AND date(source_date) <= date(?)'
    : ''
  const canonicalBindValues = evidenceMode === 'historical_replay'
    ? [tradeDate, tradeDate, finlabCutoff, tradeDate]
    : [tradeDate, tradeDate, finlabCutoff]
  let canonicalDetailsSucceeded = true

  try {
    const { results } = await databaseForDataDomain(env, 'market').prepare(`
      SELECT symbol, restriction_type, source
        FROM canonical_trading_restrictions
       WHERE 1 = 1
         ${activeClause}
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND (source != 'finlab.trading_attention' OR source_date >= ?)
         ${historicalSourceDateClause}
    `).bind(...canonicalBindValues).all<{ symbol: string | null; restriction_type: string | null; source: string | null }>()
    for (const row of results ?? []) {
      const symbol = cleanSymbol(row.symbol)
      if (!symbol || !isHardRestrictionType(row.restriction_type, row.source)) continue
      hardBlockedSymbols.add(symbol)
      addSourceCount(hardSourceCounts, row.source || 'canonical_trading_restrictions')
    }
  } catch {
    // Canonical restriction details are additive; continue with governance/KV hard sources.
    canonicalDetailsSucceeded = false
  }

  let governanceDetailsSucceeded = true
  try {
    const { results } = await databaseForDataDomain(env, 'market').prepare(`
      SELECT symbol, restriction_type, source
        FROM stock_trading_restrictions
       WHERE 1 = 1
         ${activeClause}
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND LOWER(COALESCE(restriction_type, '')) IN ('punished','disposition','delisting','suspended','halted','untradable','data_untrusted','execution_block')
    `).bind(tradeDate, tradeDate).all<{ symbol: string | null; restriction_type: string | null; source: string | null }>()
    for (const row of results ?? []) {
      const symbol = cleanSymbol(row.symbol)
      if (!symbol) continue
      hardBlockedSymbols.add(symbol)
      addSourceCount(hardSourceCounts, row.source || 'stock_trading_restrictions')
    }
  } catch {
    // Older D1 snapshots may not carry restriction_type.
    governanceDetailsSucceeded = false
  }

  if (evidenceMode === 'live_current') {
    const currentKv = await loadCurrentKvRestrictions(env.KV)
    for (const [key, symbols] of [
      ['market:punished_stocks', currentKv.punished],
      ['market:tpex_punished_stocks', currentKv.tpexPunished],
      ['market:delisting_risk', currentKv.delisting],
    ] as const) {
      for (const symbol of symbols) hardBlockedSymbols.add(symbol)
      if (symbols.length) addSourceCount(hardSourceCounts, key, symbols.length)
    }
  }

  return {
    hardBlockedSymbols,
    riskEvidenceSymbols: allRestrictions.symbols,
    sourceCounts: allRestrictions.sourceCounts,
    hardSourceCounts,
    freshness: allRestrictions.freshness,
    evidenceStatus: restrictionEvidenceStatus(
      evidenceMode,
      allRestrictions.evidenceStatus.completeness === 'COMPLETE'
        && canonicalDetailsSucceeded && governanceDetailsSucceeded,
    ),
  }
}
