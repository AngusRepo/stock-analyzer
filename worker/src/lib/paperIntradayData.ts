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
type NormalizeSnapshotOptions = { includeExecutableBook?: boolean }

function proxyHeaders(env?: IntradayEnv, json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (env?.PROXY_SERVICE_TOKEN) headers.Authorization = `Bearer ${env.PROXY_SERVICE_TOKEN}`
  return headers
}

function compactOrderbookDiagnostic(symbol: string, payload: any, fallbackStatus?: string): string {
  const detail = payload?.detail ?? payload?.data ?? payload ?? {}
  const status = String(detail?.status ?? payload?.status ?? fallbackStatus ?? 'unknown').trim()
  const parts = [
    `${symbol}:${status}`,
    detail?.quote_age_ms != null ? `age=${detail.quote_age_ms}` : null,
    detail?.max_quote_age_ms != null ? `max=${detail.max_quote_age_ms}` : null,
    detail?.source_time ? `source_time=${String(detail.source_time)}` : null,
    detail?.bid_levels != null ? `bid_levels=${detail.bid_levels}` : null,
    detail?.ask_levels != null ? `ask_levels=${detail.ask_levels}` : null,
  ].filter(Boolean)
  return parts.join(';')
}

async function readOrderbookDiagnostic(symbol: string, res: Response): Promise<string> {
  try {
    const text = await res.text()
    if (!text) return `${symbol}:http_${res.status}`
    try {
      return compactOrderbookDiagnostic(symbol, JSON.parse(text), `http_${res.status}`)
    } catch {
      return `${symbol}:http_${res.status};body=${text.slice(0, 120).replace(/\s+/g, '_')}`
    }
  } catch {
    return `${symbol}:http_${res.status};body_unavailable`
  }
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

export function normalizeShioajiSnapshot(snapshot: any, options: NormalizeSnapshotOptions = {}): IntradayOHLC | null {
  const includeExecutableBook = options.includeExecutableBook !== false
  const low = finiteTwTickPrice(snapshot?.low)
  const high = finiteTwTickPrice(snapshot?.high)
  const open = finiteTwTickPrice(snapshot?.open)
  const bid = includeExecutableBook
    ? firstFiniteTwTickPrice(snapshot?.bid, snapshot?.bid_price, snapshot?.bidPrice, snapshot?.best_bid, snapshot?.bestBid, snapshot?.bid_prices, snapshot?.bids)
    : undefined
  const ask = includeExecutableBook
    ? firstFiniteTwTickPrice(snapshot?.ask, snapshot?.ask_price, snapshot?.askPrice, snapshot?.best_ask, snapshot?.bestAsk, snapshot?.ask_prices, snapshot?.asks)
    : undefined
  const bidVolume = includeExecutableBook
    ? firstFiniteNumber(snapshot?.bid_volume, snapshot?.bidVolume, snapshot?.best_bid_volume, snapshot?.bestBidVolume, snapshot?.bid_volumes)
    : undefined
  const askVolume = includeExecutableBook
    ? firstFiniteNumber(snapshot?.ask_volume, snapshot?.askVolume, snapshot?.best_ask_volume, snapshot?.bestAskVolume, snapshot?.ask_volumes)
    : undefined
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

function normalizeShioajiOrderbook(payload: any): IntradayOHLC | null {
  const status = String(payload?.status ?? 'ok').trim().toLowerCase()
  if (status.startsWith('stale') || status === 'no_depth' || status === 'empty_depth' || status === 'error') return null

  const bid = firstFiniteTwTickPrice(payload?.bid, payload?.bid_price, payload?.best_bid, payload?.bestBid, payload?.bid_prices, payload?.bids)
  const ask = firstFiniteTwTickPrice(payload?.ask, payload?.ask_price, payload?.best_ask, payload?.bestAsk, payload?.ask_prices, payload?.asks)
  if (bid == null && ask == null) return null

  const last = firstFiniteTwTickPrice(
    payload?.last,
    payload?.last_price,
    payload?.trade_price,
    payload?.close,
    payload?.price,
    ask,
    bid,
  )
  if (last == null) return null

  const bidVolume = firstFiniteNumber(payload?.bid_volume, payload?.bidVolume, payload?.best_bid_volume, payload?.bestBidVolume, payload?.bid_volumes)
  const askVolume = firstFiniteNumber(payload?.ask_volume, payload?.askVolume, payload?.best_ask_volume, payload?.bestAskVolume, payload?.ask_volumes)
  const quoteTime = typeof payload?.source_time === 'string'
    ? payload.source_time
    : typeof payload?.quote_time === 'string'
      ? payload.quote_time
      : typeof payload?.timestamp === 'string'
        ? payload.timestamp
        : typeof payload?.updated_at === 'string'
          ? payload.updated_at
          : undefined

  return { last, bid, ask, bidVolume, askVolume, quoteTime, source: 'shioaji' }
}

function mergeSnapshotContext(current: IntradayOHLC, snapshot: any): IntradayOHLC {
  const normalized = normalizeShioajiSnapshot(snapshot, { includeExecutableBook: false })
  if (!normalized) return current
  return {
    ...current,
    low: normalized.low ?? current.low,
    high: normalized.high ?? current.high,
    open: normalized.open ?? current.open,
    totalVolume: normalized.totalVolume ?? current.totalVolume,
  }
}

async function enrichSnapshotContext(
  map: Map<string, IntradayOHLC>,
  symbols: string[],
  env?: IntradayEnv,
): Promise<void> {
  const proxyUrl = env?.SHIOAJI_PROXY_URL
  if (!proxyUrl || map.size === 0) return
  try {
    const res = await fetch(`${proxyUrl}/snapshots`, {
      method: 'POST',
      headers: proxyHeaders(env, true),
      body: JSON.stringify({ symbols }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return
    const json = await res.json() as any
    const data = json?.data ?? {}
    for (const [symbol, snapshot] of Object.entries(data)) {
      const current = map.get(symbol)
      if (current) map.set(symbol, mergeSnapshotContext(current, snapshot))
    }
  } catch (e) {
    console.warn(`[Price] snapshot context enrichment failed: ${e}`)
  }
}

async function fetchSingleOrderbookQuotes(
  symbols: string[],
  env?: IntradayEnv,
): Promise<Map<string, IntradayOHLC>> {
  const map = new Map<string, IntradayOHLC>()
  const proxyUrl = env?.SHIOAJI_PROXY_URL
  if (!proxyUrl) return map

  const results = await Promise.allSettled(symbols.map(async (symbol) => {
    const res = await fetch(`${proxyUrl}/orderbook/${symbol}`, {
      headers: proxyHeaders(env),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      console.warn(`[Price] orderbook unavailable: ${await readOrderbookDiagnostic(symbol, res)}`)
      return
    }
    const json = await res.json() as any
    const payload = json?.data ?? json
    const normalized = normalizeShioajiOrderbook(payload)
    if (!normalized) {
      console.warn(`[Price] orderbook unavailable: ${compactOrderbookDiagnostic(symbol, payload)}`)
      return
    }
    map.set(symbol, normalized)
  }))

  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed > 0) console.warn(`[Price] orderbook fetch rejected for ${failed}/${symbols.length} symbols`)
  return map
}

async function fetchFreshOrderbookQuotes(
  symbols: string[],
  env?: IntradayEnv,
): Promise<Map<string, IntradayOHLC>> {
  const map = new Map<string, IntradayOHLC>()
  const proxyUrl = env?.SHIOAJI_PROXY_URL
  if (!proxyUrl || symbols.length === 0) return map

  try {
    const res = await fetch(`${proxyUrl}/orderbooks`, {
      method: 'POST',
      headers: proxyHeaders(env, true),
      body: JSON.stringify({ symbols }),
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const json = await res.json() as any
      const data = json?.data ?? {}
      for (const [symbol, payload] of Object.entries(data)) {
        const normalized = normalizeShioajiOrderbook(payload)
        if (normalized) map.set(symbol, normalized)
      }
      const errors = json?.errors && typeof json.errors === 'object' ? Object.entries(json.errors) : []
      for (const [symbol, error] of errors.slice(0, 8)) {
        console.warn(`[Price] orderbook unavailable: ${compactOrderbookDiagnostic(symbol, error)}`)
      }
      if (errors.length > 8) console.warn(`[Price] orderbook unavailable: ${errors.length - 8} additional symbols omitted`)
      return map
    }
    if (res.status !== 404 && res.status !== 405) {
      console.warn(`[Price] batch orderbook unavailable: ${await readOrderbookDiagnostic('batch', res)}`)
    }
  } catch (e) {
    console.warn(`[Price] batch orderbook failed, fallback single orderbook: ${e}`)
  }

  return fetchSingleOrderbookQuotes(symbols, env)
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
    if (!res.ok) {
      console.warn(`[Price] orderbook enrichment unavailable: ${await readOrderbookDiagnostic(symbol, res)}`)
      return
    }
    const json = await res.json() as any
    const payload = json?.data ?? json
    const status = String(payload?.status ?? 'ok').trim().toLowerCase()
    if (status.startsWith('stale') || status === 'no_depth' || status === 'error') {
      console.warn(`[Price] orderbook enrichment unavailable: ${compactOrderbookDiagnostic(symbol, payload)}`)
      return
    }
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

  if (env?.requireBrokerQuote) {
    const orderbookMap = await fetchFreshOrderbookQuotes(symbols, env)
    if (orderbookMap.size === 0) {
      console.warn(`[Price] broker quote required; no fresh orderbook quotes for ${symbols.length} symbols`)
      return orderbookMap
    }
    await enrichSnapshotContext(orderbookMap, symbols, env)
    const sample = [...orderbookMap.entries()].slice(0, 3)
      .map(([symbol, ohlc]) => `${symbol}=bid${ohlc.bid ?? '-'} ask${ohlc.ask ?? '-'} t${ohlc.quoteTime ?? '-'}`)
      .join(', ')
    console.log(`[Price] Shioaji /orderbooks OK: ${orderbookMap.size} fresh books (${sample})`)
    return orderbookMap
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
