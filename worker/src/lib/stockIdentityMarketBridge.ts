import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

const D1_BIND_CHUNK_SIZE = 36

export type CoreStockIdentity = {
  id: number
  symbol: string
  name: string
  market: string | null
  /** Exact venue (TWSE/OTC/ROTC); `market` keeps ROTC under the legacy OTC family. */
  listing_market?: string | null
  sector: string | null
}

/** Single venue reader for board/lane decisions: exact venue first, legacy family as fallback. */
export function resolveVenue(identity: Pick<CoreStockIdentity, 'market' | 'listing_market'>): string | null {
  return identity.listing_market || identity.market || null
}

export function normalizeStockIdentitySymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

export async function loadCoreStockIdentitiesBySymbols(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  symbols: readonly string[],
  options: { requireQuerySuccess?: boolean } = {},
): Promise<Map<string, CoreStockIdentity>> {
  const normalized = normalizeStockIdentitySymbols(symbols)
  const mapped = new Map<string, CoreStockIdentity>()
  for (let offset = 0; offset < normalized.length; offset += D1_BIND_CHUNK_SIZE) {
    const chunk = normalized.slice(offset, offset + D1_BIND_CHUNK_SIZE)
    const marks = chunk.map(() => '?').join(',')
    const response = await databaseForDataDomain(env, 'core').prepare(`
      SELECT id, symbol, name, market, listing_market, sector
        FROM stocks
       WHERE symbol IN (${marks})
    `).bind(...chunk).all<CoreStockIdentity>()
    if (options.requireQuerySuccess && (!response.success || !Array.isArray(response.results))) {
      throw new Error('core_stock_identity_query_failed')
    }
    const results = response.results
    for (const row of results ?? []) mapped.set(String(row.symbol), { ...row, id: Number(row.id) })
  }
  return mapped
}

export async function loadCoreStockIdentitiesByIds(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  ids: readonly number[],
): Promise<Map<number, CoreStockIdentity>> {
  const normalized = [...new Set(ids.map(Number).filter(Number.isSafeInteger))]
  const mapped = new Map<number, CoreStockIdentity>()
  for (let offset = 0; offset < normalized.length; offset += D1_BIND_CHUNK_SIZE) {
    const chunk = normalized.slice(offset, offset + D1_BIND_CHUNK_SIZE)
    const marks = chunk.map(() => '?').join(',')
    const { results } = await databaseForDataDomain(env, 'core').prepare(`
      SELECT id, symbol, name, market, listing_market, sector
        FROM stocks
       WHERE id IN (${marks})
    `).bind(...chunk).all<CoreStockIdentity>()
    for (const row of results ?? []) mapped.set(Number(row.id), { ...row, id: Number(row.id) })
  }
  return mapped
}
export async function loadActiveCoreStockIdentities(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
): Promise<Map<string, CoreStockIdentity>> {
  const { results } = await databaseForDataDomain(env, 'core').prepare(`
    SELECT id, symbol, name, market, sector
      FROM stocks
     WHERE COALESCE(UPPER(market), '') IN ('TWSE', 'OTC')
  `).all<CoreStockIdentity>()
  return new Map((results ?? []).map((row) => [String(row.symbol), { ...row, id: Number(row.id) }]))
}
export type MarketPriceBridgeRow = {
  stock_id: number
  symbol: string
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  avg_price: number | null
  volume: number | null
}

export type MarketPriceHistoryDateBound = 'before' | 'on_or_before' | 'none'

/**
 * Latest `LIMIT ?` stock_prices rows per id (binds: JSON array of ids, [cutoff], rows per id).
 * The former per-stock ROW_NUMBER() rank (rn <= LIMIT) read every row of each stock up to the
 * cutoff (its whole history without one) to keep a handful: ~57M reads over 7 days. Each id is
 * now one backward seek on (stock_id, date) that stops after LIMIT rows, plus rowid lookups.
 * UNIQUE(stock_id, date) leaves one row per date, so "the LIMIT newest dates" is the same set
 * as rn <= LIMIT, and the outer ORDER BY only sorts the rows returned. Callers must pass
 * distinct ids (IN de-duplicated them; json_each does not) and an integer LIMIT (LIMIT rejects
 * NULL and fractions with a datatype mismatch, where rn <= ? did not), as the loader does.
 */
export function marketPriceHistorySql(bound: MarketPriceHistoryDateBound): string {
  const dateClause = bound === 'before'
    ? 'AND recent.date < ?'
    : bound === 'on_or_before'
      ? 'AND recent.date <= ?'
      : ''
  return `
      SELECT sp.stock_id, sp.date, sp.open, sp.high, sp.low, sp.close, sp.avg_price, sp.volume
        FROM json_each(?) AS ids
        CROSS JOIN stock_prices AS sp
       WHERE sp.rowid IN (
               SELECT recent.rowid
                 FROM stock_prices AS recent
                WHERE recent.stock_id = ids.value
                  ${dateClause}
                ORDER BY recent.date DESC
                LIMIT ?
             )
       ORDER BY sp.stock_id, sp.date DESC
    `
}

export async function loadMarketPriceHistoryBySymbols(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  symbols: readonly string[],
  options: { beforeDate?: string; onOrBeforeDate?: string; rowsPerSymbol?: number; requireQuerySuccess?: boolean } = {},
): Promise<MarketPriceBridgeRow[]> {
  const identities = await loadCoreStockIdentitiesBySymbols(env, symbols, options)
  const byId = new Map([...identities.values()].map((row) => [Number(row.id), row.symbol]))
  const ids = [...byId.keys()]
  const rows: MarketPriceBridgeRow[] = []
  const perSymbol = Math.max(1, Math.min(500, Math.floor(options.rowsPerSymbol ?? 120)))
  // A NaN count matched no rank (rn <= NULL); LIMIT NULL would be a datatype error instead.
  if (Number.isNaN(perSymbol)) return rows
  const bound: MarketPriceHistoryDateBound = options.beforeDate
    ? 'before'
    : options.onOrBeforeDate
      ? 'on_or_before'
      : 'none'
  const dateBinds = options.beforeDate
    ? [options.beforeDate]
    : options.onOrBeforeDate
      ? [options.onOrBeforeDate]
      : []
  const sql = marketPriceHistorySql(bound)
  // Chunks no longer guard the bind limit (one JSON bind); they keep each response at most
  // 36 ids x perSymbol rows and the output order (each chunk sorted on its own) unchanged.
  for (let offset = 0; offset < ids.length; offset += D1_BIND_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + D1_BIND_CHUNK_SIZE)
    const response = await databaseForDataDomain(env, 'market').prepare(sql)
      .bind(JSON.stringify(chunk), ...dateBinds, perSymbol).all<Omit<MarketPriceBridgeRow, 'symbol'>>()
    if (options.requireQuerySuccess && (!response.success || !Array.isArray(response.results))) {
      throw new Error('market_price_history_query_failed')
    }
    const results = response.results
    for (const row of results ?? []) {
      const symbol = byId.get(Number(row.stock_id))
      if (symbol) rows.push({ ...row, stock_id: Number(row.stock_id), symbol })
    }
  }
  return rows
}

export async function loadPreviousMarketCloseBySymbols(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  symbols: readonly string[],
  beforeDate?: string,
): Promise<Map<string, { close: number; volume: number | null; date: string }>> {
  const rows = await loadMarketPriceHistoryBySymbols(env, symbols, {
    beforeDate,
    rowsPerSymbol: 1,
  })
  const mapped = new Map<string, { close: number; volume: number | null; date: string }>()
  for (const row of rows) {
    const close = Number(row.close)
    if (Number.isFinite(close)) mapped.set(row.symbol, { close, volume: row.volume, date: row.date })
  }
  return mapped
}

export async function loadAverageMarketVolumeBySymbols(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  symbols: readonly string[],
  beforeDate: string | undefined,
  lookback: number,
): Promise<Map<string, number>> {
  const rows = await loadMarketPriceHistoryBySymbols(env, symbols, {
    beforeDate,
    rowsPerSymbol: Math.max(1, Math.min(260, Math.floor(lookback))),
  })
  const totals = new Map<string, { total: number; count: number }>()
  for (const row of rows) {
    const volume = Number(row.volume)
    if (!Number.isFinite(volume)) continue
    const current = totals.get(row.symbol) ?? { total: 0, count: 0 }
    current.total += volume
    current.count += 1
    totals.set(row.symbol, current)
  }
  return new Map([...totals].map(([symbol, value]) => [symbol, value.total / Math.max(1, value.count)]))
}
