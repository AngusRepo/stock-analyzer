import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

const D1_BIND_CHUNK_SIZE = 36

export type CoreStockIdentity = {
  id: number
  symbol: string
  name: string
  market: string | null
  sector: string | null
}

export function normalizeStockIdentitySymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((value) => String(value ?? '').trim()).filter(Boolean))]
}

export async function loadCoreStockIdentitiesBySymbols(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  symbols: readonly string[],
): Promise<Map<string, CoreStockIdentity>> {
  const normalized = normalizeStockIdentitySymbols(symbols)
  const mapped = new Map<string, CoreStockIdentity>()
  for (let offset = 0; offset < normalized.length; offset += D1_BIND_CHUNK_SIZE) {
    const chunk = normalized.slice(offset, offset + D1_BIND_CHUNK_SIZE)
    const marks = chunk.map(() => '?').join(',')
    const { results } = await databaseForDataDomain(env, 'core').prepare(`
      SELECT id, symbol, name, market, sector
        FROM stocks
       WHERE symbol IN (${marks})
    `).bind(...chunk).all<CoreStockIdentity>()
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
      SELECT id, symbol, name, market, sector
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

export async function loadMarketPriceHistoryBySymbols(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  symbols: readonly string[],
  options: { beforeDate?: string; onOrBeforeDate?: string; rowsPerSymbol?: number } = {},
): Promise<MarketPriceBridgeRow[]> {
  const identities = await loadCoreStockIdentitiesBySymbols(env, symbols)
  const byId = new Map([...identities.values()].map((row) => [Number(row.id), row.symbol]))
  const ids = [...byId.keys()]
  const rows: MarketPriceBridgeRow[] = []
  const perSymbol = Math.max(1, Math.min(500, Math.floor(options.rowsPerSymbol ?? 120)))
  for (let offset = 0; offset < ids.length; offset += D1_BIND_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + D1_BIND_CHUNK_SIZE)
    const marks = chunk.map(() => '?').join(',')
    const dateClause = options.beforeDate
      ? 'AND date < ?'
      : options.onOrBeforeDate
        ? 'AND date <= ?'
        : ''
    const dateBinds = options.beforeDate
      ? [options.beforeDate]
      : options.onOrBeforeDate
        ? [options.onOrBeforeDate]
        : []
    const { results } = await databaseForDataDomain(env, 'market').prepare(`
      SELECT stock_id, date, open, high, low, close, avg_price, volume
        FROM (
          SELECT stock_id, date, open, high, low, close, avg_price, volume,
                 ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date DESC) AS rn
            FROM stock_prices
           WHERE stock_id IN (${marks})
             ${dateClause}
        )
       WHERE rn <= ?
       ORDER BY stock_id, date DESC
    `).bind(...chunk, ...dateBinds, perSymbol).all<Omit<MarketPriceBridgeRow, 'symbol'>>()
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
