import { isValidTwTickPrice } from './twMarketRules'

export interface IntradayOHLC {
  last: number
  low?: number
  high?: number
  open?: number
  bid?: number
  ask?: number
  bidVolume?: number
  askVolume?: number
  totalVolume?: number
  quoteTime?: string
  source?: 'shioaji' | 'yahoo'
}

type IntradayEnv = { SHIOAJI_PROXY_URL?: string; PROXY_SERVICE_TOKEN?: string; requireBrokerQuote?: boolean }

function proxyHeaders(env?: IntradayEnv, json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (env?.PROXY_SERVICE_TOKEN) headers.Authorization = `Bearer ${env.PROXY_SERVICE_TOKEN}`
  return headers
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function finiteTwTickPrice(value: unknown): number | undefined {
  const n = finiteNumber(value)
  return n != null && isValidTwTickPrice(n) ? n : undefined
}

function firstFiniteTwTickPrice(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = firstFiniteTwTickPrice(...value)
      if (first != null) return first
      continue
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const n = firstFiniteTwTickPrice(obj.price, obj.p, obj.value)
      if (n != null) return n
      continue
    }
    const n = finiteTwTickPrice(value)
    if (n != null) return n
  }
  return undefined
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = firstFiniteNumber(...value)
      if (first != null) return first
      continue
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const n = firstFiniteNumber(obj.price, obj.p, obj.value, obj.volume, obj.v)
      if (n != null) return n
      continue
    }
    const n = finiteNumber(value)
    if (n != null) return n
  }
  return undefined
}

export function normalizeShioajiSnapshot(snapshot: any): IntradayOHLC | null {
  const low = finiteTwTickPrice(snapshot?.low)
  const high = finiteTwTickPrice(snapshot?.high)
  const open = finiteTwTickPrice(snapshot?.open)
  const bid = firstFiniteTwTickPrice(snapshot?.bid, snapshot?.bid_price, snapshot?.bidPrice, snapshot?.best_bid, snapshot?.bestBid, snapshot?.bid_prices, snapshot?.bids)
  const ask = firstFiniteTwTickPrice(snapshot?.ask, snapshot?.ask_price, snapshot?.askPrice, snapshot?.best_ask, snapshot?.bestAsk, snapshot?.ask_prices, snapshot?.asks)
  const bidVolume = firstFiniteNumber(snapshot?.bid_volume, snapshot?.bidVolume, snapshot?.best_bid_volume, snapshot?.bestBidVolume, snapshot?.bid_volumes)
  const askVolume = firstFiniteNumber(snapshot?.ask_volume, snapshot?.askVolume, snapshot?.best_ask_volume, snapshot?.bestAskVolume, snapshot?.ask_volumes)
  const totalVolume = firstFiniteNumber(snapshot?.total_volume, snapshot?.totalVolume, snapshot?.volume, snapshot?.totalVol)
  const quoteTime = typeof snapshot?.ts === 'string'
    ? snapshot.ts
    : typeof snapshot?.time === 'string'
      ? snapshot.time
      : typeof snapshot?.datetime === 'string'
        ? snapshot.datetime
        : typeof snapshot?.source_time === 'string'
          ? snapshot.source_time
          : typeof snapshot?.updated_at === 'string'
            ? snapshot.updated_at
            : undefined
  let last = firstFiniteTwTickPrice(
    snapshot?.last,
    snapshot?.price,
    snapshot?.last_price,
    snapshot?.trade_price,
    snapshot?.close,
  )
  if (last == null) return null

  if (low != null && last < low) last = low
  if (high != null && last > high) last = high
  if (!isValidTwTickPrice(last)) return null

  return { last, low, high, open, bid, ask, bidVolume, askVolume, totalVolume, quoteTime, source: 'shioaji' }
}

async function enrichMissingOrderbookQuotes(
  map: Map<string, IntradayOHLC>,
  symbols: string[],
  env?: IntradayEnv,
): Promise<void> {
  const proxyUrl = env?.SHIOAJI_PROXY_URL
  if (!proxyUrl) return

  const missingExecutable = symbols.filter((symbol) => {
    const quote = map.get(symbol)
    return quote?.source === 'shioaji' && (quote.bid == null || quote.ask == null)
  })
  if (missingExecutable.length === 0) return

  const results = await Promise.allSettled(missingExecutable.map(async (symbol) => {
    const res = await fetch(`${proxyUrl}/orderbook/${symbol}`, {
      headers: proxyHeaders(env),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return
    const json = await res.json() as any
    const payload = json?.data ?? json
    const status = String(payload?.status ?? 'ok').trim().toLowerCase()
    if (status.startsWith('stale') || status === 'no_depth' || status === 'error') return
    const current = map.get(symbol)
    const normalized = normalizeShioajiSnapshot({
      ...payload,
      last: payload?.last ?? payload?.price ?? current?.last,
      low: payload?.low ?? current?.low,
      high: payload?.high ?? current?.high,
      open: payload?.open ?? current?.open,
      total_volume: payload?.total_volume ?? current?.totalVolume,
    })
    if (!normalized || !current) return
    map.set(symbol, {
      ...current,
      bid: normalized.bid ?? current.bid,
      ask: normalized.ask ?? current.ask,
      bidVolume: normalized.bidVolume ?? current.bidVolume,
      askVolume: normalized.askVolume ?? current.askVolume,
      quoteTime: normalized.quoteTime ?? current.quoteTime,
    })
  }))

  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed > 0) console.warn(`[Price] orderbook enrichment failed for ${failed}/${missingExecutable.length} symbols`)
}

async function getIntradayPrice(symbol: string, env?: IntradayEnv): Promise<number | null> {
  const proxyUrl = env?.SHIOAJI_PROXY_URL
  if (proxyUrl) {
    try {
      const res = await fetch(`${proxyUrl}/quote/${symbol}`, {
        headers: proxyHeaders(env),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const json = await res.json() as any
        const normalized = normalizeShioajiSnapshot(json?.data)
        return normalized?.last ?? null
      }
    } catch {
      // Shioaji proxy unavailable; continue with fallback.
    }
  }

  if (env?.requireBrokerQuote) return null

  try {
    const twSymbol = `${symbol}.TW`
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${twSymbol}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    )
    if (!res.ok) return null
    const json = await res.json() as any
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null
  } catch {
    return null
  }
}

export async function batchGetIntradayOHLC(
  symbols: string[],
  env?: IntradayEnv,
): Promise<Map<string, IntradayOHLC>> {
  const map = new Map<string, IntradayOHLC>()
  const proxyUrl = env?.SHIOAJI_PROXY_URL
  if (!proxyUrl) {
    const priceMap = await batchGetIntradayPrices(symbols, env)
    for (const [symbol, price] of priceMap) map.set(symbol, { last: price, low: price, source: 'yahoo' })
    return map
  }

  try {
    const res = await fetch(`${proxyUrl}/snapshots`, {
      method: 'POST',
      headers: proxyHeaders(env, true),
      body: JSON.stringify({ symbols }),
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const json = await res.json() as any
      const data = json?.data ?? {}
      for (const [symbol, snapshot] of Object.entries(data)) {
        const normalized = normalizeShioajiSnapshot(snapshot)
        if (normalized) map.set(symbol, normalized)
      }
      if (map.size > 0) {
        await enrichMissingOrderbookQuotes(map, symbols, env)
        const sample = [...map.entries()].slice(0, 3)
          .map(([symbol, ohlc]) => `${symbol}=${ohlc.last}(L${ohlc.low ?? '-'}H${ohlc.high ?? '-'})`)
          .join(', ')
        console.log(`[Price] Shioaji /snapshots OK: ${map.size} quotes (${sample})`)
        return map
      }
    }
  } catch (e) {
    console.warn(`[Price] /snapshots failed, fallback /quotes: ${e}`)
  }

  if (proxyUrl) {
    try {
      const res = await fetch(`${proxyUrl}/quotes`, {
        method: 'POST',
        headers: proxyHeaders(env, true),
        body: JSON.stringify({ symbols }),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const json = await res.json() as any
        const data = json?.data ?? {}
        for (const [symbol, quote] of Object.entries(data)) {
          const normalized = normalizeShioajiSnapshot(quote)
          if (normalized) map.set(symbol, normalized)
        }
        if (map.size > 0) {
          await enrichMissingOrderbookQuotes(map, symbols, env)
          return map
        }
      }
    } catch (e) {
      console.warn(`[Price] /quotes failed, fallback Yahoo: ${e}`)
    }
  }

  if (env?.requireBrokerQuote) {
    console.warn(`[Price] broker quote required; skip Yahoo fallback for ${symbols.length} symbols`)
    return map
  }

  const priceMap = await batchGetIntradayPrices(symbols, undefined)
  for (const [symbol, price] of priceMap) map.set(symbol, { last: price, low: price, source: 'yahoo' })
  return map
}

export async function batchGetIntradayPrices(
  symbols: string[],
  env?: IntradayEnv,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const proxyUrl = env?.SHIOAJI_PROXY_URL

  if (proxyUrl) {
    try {
      const res = await fetch(`${proxyUrl}/quotes`, {
        method: 'POST',
        headers: proxyHeaders(env, true),
        body: JSON.stringify({ symbols }),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const json = await res.json() as any
        const data = json?.data ?? {}
        for (const [symbol, quote] of Object.entries(data)) {
          const normalized = normalizeShioajiSnapshot(quote)
          if (normalized) map.set(symbol, normalized.last)
        }
        if (map.size > 0) {
          console.log(`[Price] Shioaji OK: ${map.size} quotes (${[...map.entries()].map(([symbol, price]) => `${symbol}=$${price}`).join(', ')})`)
          return map
        }
      }
    } catch (e) {
      console.warn(`[Price] Shioaji failed, fallback Yahoo: ${e}`)
    }
  }

  if (env?.requireBrokerQuote) {
    console.warn(`[Price] broker quote required; skip Yahoo fallback for ${symbols.length} symbols`)
    return map
  }

  console.log(`[Price] Shioaji unavailable, using Yahoo fallback for ${symbols.length} symbols`)
  const batchSize = 5
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize)
    const results = await Promise.allSettled(
      chunk.map(async (symbol) => ({ symbol, price: await getIntradayPrice(symbol) })),
    )
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.price != null) {
        map.set(result.value.symbol, result.value.price)
      }
    }
  }
  return map
}
