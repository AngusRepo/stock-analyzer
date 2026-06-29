import type { Bindings } from '../types'
import { fetchAttentionStocks, fetchPunishedStocks } from './twseApi'

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
}

export interface TradingRestrictionBuckets {
  hardBlockedSymbols: Set<string>
  riskEvidenceSymbols: Set<string>
  sourceCounts: Record<string, number>
  hardSourceCounts: Record<string, number>
  freshness: TradingRestrictionSet['freshness']
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
  if (normalizedType === 'disposition' || normalizedSource.includes('punish') || normalizedSource.includes('disposition')) return false
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
): Promise<{ symbols: string[]; sourceCounts: Record<string, number>; latestSourceDate: string | null }> {
  try {
    const finlabCutoff = finlabTradingRestrictionCutoff(tradeDate)
    const { results } = await db.prepare(`
      SELECT symbol, source, MAX(source_date) AS latest_source_date
        FROM canonical_trading_restrictions
       WHERE COALESCE(active, 1) = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND (source != 'finlab.trading_attention' OR source_date >= ?)
       GROUP BY symbol, source
    `).bind(tradeDate, tradeDate, finlabCutoff).all<{ symbol: string | null; source: string | null; latest_source_date: string | null }>()
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
    return { symbols, sourceCounts: counts, latestSourceDate: latest }
  } catch {
    return { symbols: [], sourceCounts: {}, latestSourceDate: null }
  }
}

async function loadGovernanceRestrictions(db: D1Database, tradeDate: string): Promise<string[]> {
  try {
    const { results } = await db.prepare(`
      SELECT symbol
        FROM stock_trading_restrictions
       WHERE COALESCE(active, 1) = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
    `).bind(tradeDate, tradeDate).all<{ symbol: string | null }>()
    return (results ?? []).map((row) => cleanSymbol(row.symbol)).filter(Boolean)
  } catch {
    return []
  }
}

async function upsertOfficialRestrictions(
  env: Bindings,
  tradeDate: string,
  type: 'attention' | 'disposition',
  symbols: string[],
): Promise<void> {
  if (!symbols.length) return
  const source = type === 'attention' ? 'official.twse_notice' : 'official.twse_punish'
  const sourceUrl = type === 'attention'
    ? 'https://www.twse.com.tw/rwd/zh/announcement/notice?response=json'
    : 'https://www.twse.com.tw/rwd/zh/announcement/punish?response=json'
  const statements = symbols.map((symbol) => env.DB.prepare(`
    INSERT INTO canonical_trading_restrictions (
      symbol, restriction_type, market_segment, start_date, end_date, source,
      source_date, title, source_url, lineage_json, active, updated_at
    )
    VALUES (?, ?, 'LISTED_OTC', ?, NULL, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
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
    tradeDate,
    source,
    tradeDate,
    `${type}:${symbol}`,
    sourceUrl,
    JSON.stringify({ schema_version: 'canonical-trading-restrictions-v1', source, fetch_mode: 'official_fallback' }),
  ))
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50))
  }
}

export async function refreshOfficialTradingRestrictions(env: Bindings, tradeDate: string): Promise<Record<string, number>> {
  const [punishedResult, attentionResult] = await Promise.allSettled([
    fetchPunishedStocks(),
    fetchAttentionStocks(),
  ])
  const counts: Record<string, number> = {}
  if (punishedResult.status === 'fulfilled' && punishedResult.value.length > 0) {
    await env.KV.put('market:punished_stocks', JSON.stringify(punishedResult.value), { expirationTtl: 86400 })
    await upsertOfficialRestrictions(env, tradeDate, 'disposition', punishedResult.value)
    counts['official.twse_punish'] = punishedResult.value.length
  }
  if (attentionResult.status === 'fulfilled' && attentionResult.value.length > 0) {
    await env.KV.put('market:attention_stocks', JSON.stringify(attentionResult.value), { expirationTtl: 86400 })
    await upsertOfficialRestrictions(env, tradeDate, 'attention', attentionResult.value)
    counts['official.twse_notice'] = attentionResult.value.length
  }
  await env.KV.put('market:restricted_execution_checked_at', new Date().toISOString(), { expirationTtl: 3600 })
  await env.KV.put('market:trading_restrictions:checked_at', new Date().toISOString(), { expirationTtl: 86400 })
  return counts
}

export async function loadTradingRestrictionSet(
  env: Bindings,
  tradeDate: string,
  options: { refreshOfficialIfStale?: boolean; refreshTtlMs?: number } = {},
): Promise<TradingRestrictionSet> {
  const target = new Set<string>()
  const sourceCounts: Record<string, number> = {}

  const canonical = await loadCanonicalRestrictions(env.DB, tradeDate)
  for (const symbol of canonical.symbols) target.add(symbol)
  for (const [source, count] of Object.entries(canonical.sourceCounts)) addSourceCount(sourceCounts, source, count)

  const governance = await loadGovernanceRestrictions(env.DB, tradeDate)
  for (const symbol of governance) target.add(symbol)
  if (governance.length) addSourceCount(sourceCounts, 'stock_trading_restrictions', governance.length)

  const [
    cachedPunished,
    cachedAttention,
    cachedTpexPunished,
    cachedTpexAttention,
    cachedDelisting,
    checkedAtRaw,
  ] = await Promise.all([
    readSymbolList(env.KV, 'market:punished_stocks'),
    readSymbolList(env.KV, 'market:attention_stocks'),
    readSymbolList(env.KV, 'market:tpex_punished_stocks'),
    readSymbolList(env.KV, 'market:tpex_attention_stocks'),
    readSymbolList(env.KV, 'market:delisting_risk'),
    env.KV.get('market:trading_restrictions:checked_at'),
  ])
  const kvRows = [
    ...cachedPunished,
    ...cachedAttention,
    ...cachedTpexPunished,
    ...cachedTpexAttention,
    ...cachedDelisting,
  ]
  for (const symbol of kvRows) target.add(symbol)
  if (kvRows.length) addSourceCount(sourceCounts, 'kv_fallback', kvRows.length)

  const refreshTtlMs = options.refreshTtlMs ?? 12 * 60 * 60_000
  const checkedAtMs = checkedAtRaw ? Date.parse(checkedAtRaw) : 0
  const stale = !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > refreshTtlMs
  if (options.refreshOfficialIfStale && stale) {
    const officialCounts = await refreshOfficialTradingRestrictions(env, tradeDate).catch(() => ({}))
    for (const [source, count] of Object.entries(officialCounts)) addSourceCount(sourceCounts, source, count)
    for (const symbol of await readSymbolList(env.KV, 'market:punished_stocks')) target.add(symbol)
    for (const symbol of await readSymbolList(env.KV, 'market:attention_stocks')) target.add(symbol)
  }

  return {
    symbols: target,
    sourceCounts,
    freshness: {
      canonicalLatestSourceDate: canonical.latestSourceDate,
      officialCheckedAt: checkedAtRaw,
    },
  }
}

export async function loadTradingRestrictionBuckets(
  env: Bindings,
  tradeDate: string,
  options: { refreshOfficialIfStale?: boolean; refreshTtlMs?: number } = {},
): Promise<TradingRestrictionBuckets> {
  const allRestrictions = await loadTradingRestrictionSet(env, tradeDate, options)
  const hardBlockedSymbols = new Set<string>()
  const hardSourceCounts: Record<string, number> = {}
  const finlabCutoff = finlabTradingRestrictionCutoff(tradeDate)

  try {
    const { results } = await env.DB.prepare(`
      SELECT symbol, restriction_type, source
        FROM canonical_trading_restrictions
       WHERE COALESCE(active, 1) = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND (source != 'finlab.trading_attention' OR source_date >= ?)
    `).bind(tradeDate, tradeDate, finlabCutoff).all<{ symbol: string | null; restriction_type: string | null; source: string | null }>()
    for (const row of results ?? []) {
      const symbol = cleanSymbol(row.symbol)
      if (!symbol || !isHardRestrictionType(row.restriction_type, row.source)) continue
      hardBlockedSymbols.add(symbol)
      addSourceCount(hardSourceCounts, row.source || 'canonical_trading_restrictions')
    }
  } catch {
    // Canonical restriction details are additive; continue with governance/KV hard sources.
  }

  try {
    const { results } = await env.DB.prepare(`
      SELECT symbol, restriction_type, source
        FROM stock_trading_restrictions
       WHERE COALESCE(active, 1) = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
         AND LOWER(COALESCE(restriction_type, '')) IN ('delisting','suspended','halted','untradable','data_untrusted','execution_block')
    `).bind(tradeDate, tradeDate).all<{ symbol: string | null; restriction_type: string | null; source: string | null }>()
    for (const row of results ?? []) {
      const symbol = cleanSymbol(row.symbol)
      if (!symbol) continue
      hardBlockedSymbols.add(symbol)
      addSourceCount(hardSourceCounts, row.source || 'stock_trading_restrictions')
    }
  } catch {
    // Older D1 snapshots may not carry restriction_type.
  }

  const [delisting] = await Promise.all([
    readSymbolList(env.KV, 'market:delisting_risk'),
  ])
  for (const symbol of delisting) hardBlockedSymbols.add(symbol)
  if (delisting.length) addSourceCount(hardSourceCounts, 'market:delisting_risk', delisting.length)

  return {
    hardBlockedSymbols,
    riskEvidenceSymbols: allRestrictions.symbols,
    sourceCounts: allRestrictions.sourceCounts,
    hardSourceCounts,
    freshness: allRestrictions.freshness,
  }
}
