export interface IntradayOHLC {
  last: number
  low?: number
  high?: number
  open?: number
  source?: 'shioaji' | 'yahoo'
}

type IntradayEnv = { SHIOAJI_PROXY_URL?: string; PROXY_SERVICE_TOKEN?: string }

function proxyHeaders(env?: IntradayEnv, json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (env?.PROXY_SERVICE_TOKEN) headers.Authorization = `Bearer ${env.PROXY_SERVICE_TOKEN}`
  return headers
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
        return json?.data?.price ?? null
      }
    } catch {
      // Shioaji proxy unavailable; continue with fallback.
    }
  }

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
        const s = snapshot as any
        const last = s?.close ?? s?.last ?? s?.price
        if (last == null) continue
        map.set(symbol, {
          last: Number(last),
          low: s?.low != null ? Number(s.low) : undefined,
          high: s?.high != null ? Number(s.high) : undefined,
          open: s?.open != null ? Number(s.open) : undefined,
          source: 'shioaji',
        })
      }
      if (map.size > 0) {
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
          const price = (quote as any)?.price
          if (price != null) map.set(symbol, { last: Number(price), low: Number(price), source: 'shioaji' })
        }
        if (map.size > 0) return map
      }
    } catch (e) {
      console.warn(`[Price] /quotes failed, fallback Yahoo: ${e}`)
    }
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
          const price = (quote as any)?.price
          if (price != null) map.set(symbol, price)
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
