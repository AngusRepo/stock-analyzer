export interface FinLabL5Quote {
  provider: string
  symbol: string
  lastPrice?: number
  bestBid?: number
  bestAsk?: number
  bidPrices: number[]
  askPrices: number[]
  bidVolumes: number[]
  askVolumes: number[]
  sourceTime?: string | null
  receivedAt?: string | null
  quoteAgeMs?: number | null
  spreadPct?: number | null
  orderBookImbalance?: number | null
  rawStatus?: string | null
}

export interface L5QuoteQualityThresholds {
  maxQuoteAgeMs: number
  maxSpreadPct: number
  minDepthLevels: number
  minTopAskVolume: number
  minOrderBookImbalance: number
}

export interface L5QuoteQuality {
  status: 'pass' | 'degraded' | 'blocked'
  reasons: string[]
  metrics: {
    quoteAgeMs?: number | null
    spreadPct?: number | null
    depthLevels?: number
    topAskVolume?: number | null
    orderBookImbalance?: number | null
  }
}

export interface FinLabL5MarketDataSnapshot {
  status: string | null
  blockedReasons: string[]
  envMissing: string[]
  liveSubmitEnabled: boolean
  canSubmitRealOrder: boolean
  quotes: Map<string, FinLabL5Quote>
  raw?: Record<string, unknown> | null
}

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function numbersFrom(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const n = finitePositive(obj.price ?? obj.p ?? obj.value)
      if (n != null) out.push(n)
      continue
    }
    const n = finitePositive(item)
    if (n != null) out.push(n)
  }
  return out
}

function integerVolumesFrom(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        return Number.parseInt(String(obj.volume ?? obj.v ?? obj.value ?? 0), 10)
      }
      return Number.parseInt(String(item ?? 0), 10)
    })
    .filter((n) => Number.isFinite(n) && n >= 0)
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const found = firstNumber(...value)
      if (found != null) return found
      continue
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      const found = firstNumber(obj.price, obj.p, obj.value)
      if (found != null) return found
      continue
    }
    const n = finitePositive(value)
    if (n != null) return n
  }
  return undefined
}

function roundMetric(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function parseTimeMs(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (value > 10 ** 14) return Math.floor(value / 1000)
    if (value > 10 ** 11) return Math.floor(value)
    return Math.floor(value * 1000)
  }
  const text = String(value).trim()
  if (!text) return null
  const ts = Date.parse(text.includes('T') ? text : text.replace(' ', 'T'))
  return Number.isFinite(ts) ? ts : null
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

export function normalizeFinLabL5Quote(
  symbol: string,
  payload: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): FinLabL5Quote | null {
  if (!payload) return null
  const bidPrices = numbersFrom(payload.bid_prices ?? payload.bidPrices ?? payload.bid_prices_top5 ?? payload.bids).slice(0, 5)
  const askPrices = numbersFrom(payload.ask_prices ?? payload.askPrices ?? payload.ask_prices_top5 ?? payload.asks).slice(0, 5)
  const bidVolumes = integerVolumesFrom(payload.bid_volumes ?? payload.bidVolumes ?? payload.bid_volumes_top5 ?? payload.bids).slice(0, 5)
  const askVolumes = integerVolumesFrom(payload.ask_volumes ?? payload.askVolumes ?? payload.ask_volumes_top5 ?? payload.asks).slice(0, 5)
  const bestBid = firstNumber(payload.best_bid, payload.bestBid, payload.bid, bidPrices)
  const bestAsk = firstNumber(payload.best_ask, payload.bestAsk, payload.ask, askPrices)
  const lastPrice = firstNumber(payload.price, payload.last, payload.last_price, payload.close)
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null
  const spreadPct = mid && bestAsk != null && bestBid != null ? roundMetric((bestAsk - bestBid) / mid) : null
  const bidDepth = sum(bidVolumes)
  const askDepth = sum(askVolumes)
  const totalDepth = bidDepth + askDepth
  const orderBookImbalance = totalDepth > 0 ? roundMetric((bidDepth - askDepth) / totalDepth) : null
  const sourceTime = payload.source_time ?? payload.quote_time ?? payload.time ?? payload.updated_at ?? payload.timestamp
  const sourceMs = parseTimeMs(sourceTime)
  const nowMs = now.getTime()
  const quoteAgeMs = sourceMs != null ? Math.max(0, nowMs - sourceMs) : null

  return {
    provider: String(payload.provider ?? 'finlab_sinopac'),
    symbol,
    lastPrice,
    bestBid,
    bestAsk,
    bidPrices,
    askPrices,
    bidVolumes,
    askVolumes,
    sourceTime: sourceTime != null ? String(sourceTime) : null,
    receivedAt: payload.received_at != null ? String(payload.received_at) : now.toISOString(),
    quoteAgeMs,
    spreadPct,
    orderBookImbalance,
    rawStatus: payload.status != null ? String(payload.status) : null,
  }
}

export function quoteQualityFromL5(
  quote: FinLabL5Quote | null,
  thresholds: L5QuoteQualityThresholds,
): L5QuoteQuality {
  if (!quote) {
    return {
      status: 'blocked',
      reasons: ['missing_l5_quote'],
      metrics: { depthLevels: 0 },
    }
  }

  const reasons: string[] = []
  const degraded: string[] = []
  const depthLevels = Math.min(quote.bidPrices.length, quote.askPrices.length)
  if (depthLevels < thresholds.minDepthLevels) degraded.push('l5_depth_incomplete')
  if (quote.quoteAgeMs != null && quote.quoteAgeMs > thresholds.maxQuoteAgeMs) reasons.push('stale_l5_quote')
  if (quote.spreadPct != null && quote.spreadPct > thresholds.maxSpreadPct) reasons.push('wide_l5_spread')
  if ((quote.askVolumes[0] ?? 0) < thresholds.minTopAskVolume) reasons.push('thin_top_ask')
  if (quote.orderBookImbalance != null && quote.orderBookImbalance < thresholds.minOrderBookImbalance) reasons.push('weak_l5_imbalance')
  if (quote.bestAsk == null || quote.bestBid == null) reasons.push('missing_executable_l1')

  return {
    status: reasons.length > 0 ? 'blocked' : degraded.length > 0 ? 'degraded' : 'pass',
    reasons: [...reasons, ...degraded],
    metrics: {
      quoteAgeMs: quote.quoteAgeMs,
      spreadPct: quote.spreadPct,
      depthLevels,
      topAskVolume: quote.askVolumes[0] ?? null,
      orderBookImbalance: quote.orderBookImbalance,
    },
  }
}

export function buildFinLabL5MarketDataDetail(quote: FinLabL5Quote | null): Record<string, unknown> {
  return {
    provider: quote?.provider ?? 'finlab_sinopac',
    symbol: quote?.symbol ?? null,
    last_price: quote?.lastPrice ?? null,
    best_bid: quote?.bestBid ?? null,
    best_ask: quote?.bestAsk ?? null,
    bid_prices: quote?.bidPrices ?? [],
    ask_prices: quote?.askPrices ?? [],
    bid_volumes: quote?.bidVolumes ?? [],
    ask_volumes: quote?.askVolumes ?? [],
    spread_pct: quote?.spreadPct ?? null,
    order_book_imbalance: quote?.orderBookImbalance ?? null,
    quote_age_ms: quote?.quoteAgeMs ?? null,
    l5_depth_levels: quote ? Math.min(quote.bidPrices.length, quote.askPrices.length) : 0,
    source_time: quote?.sourceTime ?? null,
    received_at: quote?.receivedAt ?? null,
    live_submit_enabled: false,
  }
}

function truthyFlag(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function emptyL5MarketDataSnapshot(status: string | null = null): FinLabL5MarketDataSnapshot {
  return {
    status,
    blockedReasons: [],
    envMissing: [],
    liveSubmitEnabled: false,
    canSubmitRealOrder: false,
    quotes: new Map(),
    raw: null,
  }
}

export async function fetchFinLabL5MarketDataSnapshot(
  env: {
    ML_CONTROLLER_URL?: string
    ML_CONTROLLER_SECRET?: string
    FINLAB_L5_MARKET_DATA_ENABLED?: string
    FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN?: string
  },
  symbols: string[],
): Promise<FinLabL5MarketDataSnapshot> {
  const snapshot = emptyL5MarketDataSnapshot()
  const controllerUrl = env.ML_CONTROLLER_URL?.trim()
  const marketDataEnabled = truthyFlag(env.FINLAB_L5_MARKET_DATA_ENABLED)
  if (!marketDataEnabled) return emptyL5MarketDataSnapshot('disabled')
  if (!controllerUrl) return emptyL5MarketDataSnapshot('missing_controller_url')
  if (symbols.length === 0) return emptyL5MarketDataSnapshot('empty_symbols')

  try {
    const route = '/finlab/execution/l5-market-data'
    const res = await fetch(`${controllerUrl.replace(/\/$/, '')}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.ML_CONTROLLER_SECRET ? { 'X-Controller-Token': env.ML_CONTROLLER_SECRET } : {}),
      },
      body: JSON.stringify({
        symbols,
        allow_broker_login: truthyFlag(env.FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN),
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return emptyL5MarketDataSnapshot(`http_${res.status}`)
    const payload = await res.json() as any
    snapshot.status = payload?.status != null ? String(payload.status) : null
    snapshot.blockedReasons = textArray(payload?.blocked_reasons)
    snapshot.envMissing = textArray(payload?.env_status?.missing)
    snapshot.liveSubmitEnabled = payload?.live_submit_enabled === true
    snapshot.canSubmitRealOrder = payload?.can_submit_real_order === true
    snapshot.raw = payload && typeof payload === 'object'
      ? {
        schema_version: payload.schema_version,
        allowed_use: payload.allowed_use,
        status: payload.status,
        blocked_reasons: payload.blocked_reasons,
        env_status: payload.env_status,
      }
      : null
    if (snapshot.canSubmitRealOrder || snapshot.liveSubmitEnabled) return snapshot
    const quotes = payload?.quotes && typeof payload.quotes === 'object' ? payload.quotes : {}
    for (const [symbol, quotePayload] of Object.entries(quotes)) {
      const quote = normalizeFinLabL5Quote(symbol, quotePayload as Record<string, unknown>)
      if (quote) snapshot.quotes.set(symbol, quote)
    }
  } catch (error) {
    console.warn(`[FinLabL5MarketData] fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    return emptyL5MarketDataSnapshot('fetch_failed')
  }
  return snapshot
}

export async function fetchFinLabL5MarketDataQuotes(
  env: {
    ML_CONTROLLER_URL?: string
    ML_CONTROLLER_SECRET?: string
    FINLAB_L5_MARKET_DATA_ENABLED?: string
    FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN?: string
  },
  symbols: string[],
): Promise<Map<string, FinLabL5Quote>> {
  const snapshot = await fetchFinLabL5MarketDataSnapshot(env, symbols)
  return snapshot.quotes
}
