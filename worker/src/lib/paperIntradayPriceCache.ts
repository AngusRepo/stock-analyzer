import type { Bindings } from '../types'
import { batchGetIntradayOHLC } from './paperIntradayData'

const ACCOUNT_ID = 1
export const INTRADAY_PRICE_PREFIX = 'intraday:price:'
export const INTRADAY_PRICE_TTL_SECONDS = 600
export const POST_CLOSE_PRICE_PREFIX = 'postclose:price:'
export const POST_CLOSE_PRICE_TTL_SECONDS = 18 * 60 * 60

export type PostClosePriceSnapshot = {
  symbol: string
  price: number
  source: string
  trade_date: string
  updated_at: string
}

export type PostClosePriceRefreshResult = {
  tradeDate: string
  requested: number
  refreshed: number
  failed: number
  prices: Map<string, PostClosePriceSnapshot>
  summary: string
}

function twToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parsePostCloseSnapshot(raw: unknown): PostClosePriceSnapshot | null {
  if (!raw || typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw) as Partial<PostClosePriceSnapshot>
    const symbol = String(parsed.symbol ?? '').trim()
    const price = finitePositive(parsed.price)
    const tradeDate = String(parsed.trade_date ?? '').slice(0, 10)
    if (!symbol || price == null || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return null
    return {
      symbol,
      price,
      source: String(parsed.source ?? 'post_close_quote'),
      trade_date: tradeDate,
      updated_at: String(parsed.updated_at ?? ''),
    }
  } catch {
    return null
  }
}

export async function putIntradayPrice(
  kv: KVNamespace,
  symbol: string,
  price: number,
  ttlSeconds = INTRADAY_PRICE_TTL_SECONDS,
): Promise<void> {
  await kv.put(`${INTRADAY_PRICE_PREFIX}${symbol}`, String(price), { expirationTtl: ttlSeconds })
}

export async function putPostClosePrice(
  kv: KVNamespace,
  snapshot: PostClosePriceSnapshot,
  ttlSeconds = POST_CLOSE_PRICE_TTL_SECONDS,
): Promise<void> {
  await kv.put(`${POST_CLOSE_PRICE_PREFIX}${snapshot.symbol}`, JSON.stringify(snapshot), { expirationTtl: ttlSeconds })
}

export async function getPostClosePriceMap(
  kv: KVNamespace,
  symbols: string[],
  tradeDate = twToday(),
): Promise<Map<string, PostClosePriceSnapshot>> {
  const uniqueSymbols = [...new Set(symbols.map((symbol) => String(symbol ?? '').trim()).filter(Boolean))]
  const rows = await Promise.all(uniqueSymbols.map((symbol) => kv.get(`${POST_CLOSE_PRICE_PREFIX}${symbol}`)))
  const out = new Map<string, PostClosePriceSnapshot>()
  for (let i = 0; i < uniqueSymbols.length; i += 1) {
    const parsed = parsePostCloseSnapshot(rows[i])
    if (!parsed || parsed.trade_date !== tradeDate) continue
    out.set(uniqueSymbols[i], parsed)
  }
  return out
}

export async function refreshOpenPositionPostClosePriceCache(
  env: Pick<Bindings, 'DB' | 'KV' | 'SHIOAJI_PROXY_URL' | 'PROXY_SERVICE_TOKEN'>,
  options: { tradeDate?: string } = {},
): Promise<PostClosePriceRefreshResult> {
  const tradeDate = options.tradeDate ?? twToday()
  const { results } = await env.DB.prepare(
    'SELECT symbol FROM paper_positions WHERE account_id=? AND shares>0',
  ).bind(ACCOUNT_ID).all<{ symbol: string }>()
  const symbols = [...new Set((results ?? []).map((row) => String(row.symbol ?? '').trim()).filter(Boolean))]
  if (!symbols.length) {
    return {
      tradeDate,
      requested: 0,
      refreshed: 0,
      failed: 0,
      prices: new Map(),
      summary: `post_close_price_cache_refreshed=0/0 date=${tradeDate}`,
    }
  }

  const quoteMap = await batchGetIntradayOHLC(symbols, {
    SHIOAJI_PROXY_URL: env.SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: env.PROXY_SERVICE_TOKEN,
  })
  const updatedAt = new Date().toISOString()
  const snapshots = symbols
    .map((symbol) => {
      const quote = quoteMap.get(symbol)
      const price = finitePositive(quote?.last)
      if (price == null) return null
      return {
        symbol,
        price,
        source: quote?.source ? `post_close_${quote.source}` : 'post_close_quote',
        trade_date: tradeDate,
        updated_at: updatedAt,
      } satisfies PostClosePriceSnapshot
    })
    .filter((snapshot): snapshot is PostClosePriceSnapshot => Boolean(snapshot))
  const writes = await Promise.allSettled(snapshots.map((snapshot) => putPostClosePrice(env.KV, snapshot)))
  const prices = new Map<string, PostClosePriceSnapshot>()
  let refreshed = 0
  for (let i = 0; i < snapshots.length; i += 1) {
    if (writes[i]?.status !== 'fulfilled') continue
    refreshed += 1
    prices.set(snapshots[i].symbol, snapshots[i])
  }
  const failed = symbols.length - refreshed
  const sourceCounts = [...prices.values()].reduce<Record<string, number>>((acc, snapshot) => {
    acc[snapshot.source] = (acc[snapshot.source] ?? 0) + 1
    return acc
  }, {})
  const sourceSummary = Object.entries(sourceCounts)
    .map(([source, count]) => `${source}:${count}`)
    .join(',')
  return {
    tradeDate,
    requested: symbols.length,
    refreshed,
    failed,
    prices,
    summary: `post_close_price_cache_refreshed=${refreshed}/${symbols.length} date=${tradeDate}${failed ? ` failed=${failed}` : ''}${sourceSummary ? ` sources=${sourceSummary}` : ''}`,
  }
}

export async function clearOpenPositionIntradayPriceCache(
  env: Pick<Bindings, 'DB' | 'KV'>,
  accountId = ACCOUNT_ID,
): Promise<string> {
  const { results } = await env.DB.prepare(
    'SELECT symbol FROM paper_positions WHERE account_id=? AND shares>0',
  ).bind(accountId).all<{ symbol: string }>()

  const symbols = [...new Set((results ?? []).map((row) => String(row.symbol ?? '').trim()).filter(Boolean))]
  const deletes = await Promise.allSettled(
    symbols.map((symbol) => env.KV.delete(`${INTRADAY_PRICE_PREFIX}${symbol}`)),
  )
  const cleared = deletes.filter((result) => result.status === 'fulfilled').length
  const failed = deletes.length - cleared
  return `intraday_price_cache_cleared=${cleared}/${symbols.length}${failed ? ` failed=${failed}` : ''}`
}
