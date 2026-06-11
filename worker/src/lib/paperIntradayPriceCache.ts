import type { Bindings } from '../types'

const ACCOUNT_ID = 1
export const INTRADAY_PRICE_PREFIX = 'intraday:price:'
export const INTRADAY_PRICE_TTL_SECONDS = 600

export async function putIntradayPrice(
  kv: KVNamespace,
  symbol: string,
  price: number,
  ttlSeconds = INTRADAY_PRICE_TTL_SECONDS,
): Promise<void> {
  await kv.put(`${INTRADAY_PRICE_PREFIX}${symbol}`, String(price), { expirationTtl: ttlSeconds })
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
