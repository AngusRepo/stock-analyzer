import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export type PaperMarketDomainDataEnv = Pick<Bindings, 'DB'> & Partial<Bindings>
type IdentityRow = { id: number; symbol: string }
type PriceRow = { stock_id: number; price: number | null }
type AtrRow = { stock_id: number; atr14: number | null }

async function identities(coreDb: D1Database, symbols: string[]): Promise<Map<string, number>> {
  const normalized = [...new Set(symbols.map((value) => value.trim()).filter(Boolean))]
  if (!normalized.length) return new Map()
  const marks = normalized.map(() => '?').join(',')
  const { results } = await coreDb.prepare(
    `SELECT id, symbol FROM stocks WHERE symbol IN (${marks})`,
  ).bind(...normalized).all<IdentityRow>()
  return new Map((results ?? []).map((row) => [String(row.symbol), Number(row.id)]))
}

function mapByIdentity<T extends { stock_id: number }>(
  identity: Map<string, number>, rows: T[], value: (row: T) => number,
): Map<string, number> {
  const symbols = new Map([...identity].map(([symbol, id]) => [id, symbol]))
  const mapped = new Map<string, number>()
  for (const row of rows) {
    const symbol = symbols.get(Number(row.stock_id))
    const numeric = value(row)
    if (symbol && Number.isFinite(numeric)) mapped.set(symbol, numeric)
  }
  return mapped
}

export async function batchGetLatestPricesFromDomains(
  coreDb: D1Database, marketDb: D1Database, symbols: string[], asOfDate?: string,
): Promise<Map<string, number>> {
  const identity = await identities(coreDb, symbols)
  const ids = [...new Set(identity.values())]
  if (!ids.length) return new Map()
  const marks = ids.map(() => '?').join(',')
  const cutoff = asOfDate ?? '9999-12-31'
  const { results } = await marketDb.prepare(`
    SELECT p.stock_id, p.close AS price
      FROM stock_prices p
     WHERE p.stock_id IN (${marks}) AND p.date <= ? AND p.close IS NOT NULL
       AND p.date = (SELECT MAX(x.date) FROM stock_prices x
                      WHERE x.stock_id=p.stock_id AND x.date <= ? AND x.close IS NOT NULL)
  `).bind(...ids, cutoff, cutoff).all<PriceRow>()
  return mapByIdentity(identity, results ?? [], (row) => Number(row.price))
}

export async function batchGetLatestPricesByDomain(
  env: PaperMarketDomainDataEnv, symbols: string[], asOfDate?: string,
): Promise<Map<string, number>> {
  return batchGetLatestPricesFromDomains(
    databaseForDataDomain(env, 'core'), databaseForDataDomain(env, 'market'), symbols, asOfDate,
  )
}

export async function getLatestPriceByDomain(
  env: PaperMarketDomainDataEnv, symbol: string, asOfDate?: string,
): Promise<number | null> {
  return (await batchGetLatestPricesByDomain(env, [symbol], asOfDate)).get(symbol) ?? null
}

export async function batchGetAtrFromDomains(
  coreDb: D1Database, marketDb: D1Database, symbols: string[], asOfDate?: string,
): Promise<Map<string, number>> {
  const identity = await identities(coreDb, symbols)
  const ids = [...new Set(identity.values())]
  if (!ids.length) return new Map()
  const marks = ids.map(() => '?').join(',')
  const cutoff = asOfDate ?? '9999-12-31'
  const { results } = await marketDb.prepare(`
    SELECT t.stock_id, t.atr14
      FROM technical_indicators t
     WHERE t.stock_id IN (${marks}) AND t.date <= ? AND t.atr14 IS NOT NULL
       AND t.date = (SELECT MAX(x.date) FROM technical_indicators x
                      WHERE x.stock_id=t.stock_id AND x.date <= ? AND x.atr14 IS NOT NULL)
  `).bind(...ids, cutoff, cutoff).all<AtrRow>()
  return mapByIdentity(identity, results ?? [], (row) => Number(row.atr14))
}

export async function batchGetAtrByDomain(
  env: PaperMarketDomainDataEnv, symbols: string[], asOfDate?: string,
): Promise<Map<string, number>> {
  return batchGetAtrFromDomains(
    databaseForDataDomain(env, 'core'), databaseForDataDomain(env, 'market'), symbols, asOfDate,
  )
}
