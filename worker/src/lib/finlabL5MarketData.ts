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

export interface L5OrderBookPersistenceOptions {
  minSamples?: number
  minPositiveImbalanceRatio?: number
  minAverageImbalance?: number
  minPositiveImbalance?: number
  maxAverageSpreadPct?: number
  minSpreadCompressionPct?: number
  minTopAskVolumeDropRatio?: number
  minBidDepthGrowthRatio?: number
  maxAskDepthGrowthRatio?: number
}

export interface L5OrderBookPersistence {
  status: 'boost' | 'neutral' | 'degraded' | 'blocked'
  reasons: string[]
  metrics: {
    samples: number
    positiveImbalanceRatio: number | null
    averageImbalance: number | null
    averageSpreadPct: number | null
    spreadCompressionPct: number | null
    topAskVolumeDropRatio: number | null
    bidDepthGrowthRatio: number | null
    askDepthGrowthRatio: number | null
    bestAskConsumedCount: number
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

function finiteMetric(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function average(values: number[]): number | null {
  if (!values.length) return null
  return roundMetric(values.reduce((acc, value) => acc + value, 0) / values.length)
}

function depthRatio(first: number, last: number): number | null {
  if (!Number.isFinite(first) || first <= 0 || !Number.isFinite(last)) return null
  return roundMetric((last - first) / first)
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

export function evaluateL5OrderBookPersistence(
  quotes: Array<FinLabL5Quote | null | undefined>,
  options: L5OrderBookPersistenceOptions = {},
): L5OrderBookPersistence {
  const thresholds = {
    minSamples: Math.max(2, Math.floor(options.minSamples ?? 3)),
    minPositiveImbalanceRatio: options.minPositiveImbalanceRatio ?? 0.6,
    minAverageImbalance: options.minAverageImbalance ?? 0.05,
    minPositiveImbalance: options.minPositiveImbalance ?? 0.03,
    maxAverageSpreadPct: options.maxAverageSpreadPct ?? 0.006,
    minSpreadCompressionPct: options.minSpreadCompressionPct ?? 0,
    minTopAskVolumeDropRatio: options.minTopAskVolumeDropRatio ?? 0.2,
    minBidDepthGrowthRatio: options.minBidDepthGrowthRatio ?? 0,
    maxAskDepthGrowthRatio: options.maxAskDepthGrowthRatio ?? 0.15,
  }
  const clean = quotes
    .filter((quote): quote is FinLabL5Quote => !!quote)
    .filter((quote) => quote.bestBid != null && quote.bestAsk != null)
  const emptyMetrics: L5OrderBookPersistence['metrics'] = {
    samples: clean.length,
    positiveImbalanceRatio: null,
    averageImbalance: null,
    averageSpreadPct: null,
    spreadCompressionPct: null,
    topAskVolumeDropRatio: null,
    bidDepthGrowthRatio: null,
    askDepthGrowthRatio: null,
    bestAskConsumedCount: 0,
  }
  if (clean.length < thresholds.minSamples) {
    return {
      status: 'neutral',
      reasons: ['insufficient_l5_persistence_samples'],
      metrics: emptyMetrics,
    }
  }

  const imbalances = clean
    .map((quote) => finiteMetric(quote.orderBookImbalance))
    .filter((value): value is number => value != null)
  const spreads = clean
    .map((quote) => finiteMetric(quote.spreadPct))
    .filter((value): value is number => value != null && value >= 0)
  const first = clean[0]
  const last = clean[clean.length - 1]
  const firstSpread = finiteMetric(first.spreadPct)
  const lastSpread = finiteMetric(last.spreadPct)
  const firstTopAsk = finiteMetric(first.askVolumes[0]) ?? 0
  const lastTopAsk = finiteMetric(last.askVolumes[0]) ?? 0
  const firstBidDepth = sum(first.bidVolumes)
  const lastBidDepth = sum(last.bidVolumes)
  const firstAskDepth = sum(first.askVolumes)
  const lastAskDepth = sum(last.askVolumes)
  const positiveImbalanceRatio = imbalances.length
    ? roundMetric(imbalances.filter((value) => value >= thresholds.minPositiveImbalance).length / imbalances.length)
    : null
  const averageImbalance = average(imbalances)
  const averageSpreadPct = average(spreads)
  const spreadCompressionPct = firstSpread != null && firstSpread > 0 && lastSpread != null
    ? roundMetric((firstSpread - lastSpread) / firstSpread)
    : null
  const topAskVolumeDropRatio = firstTopAsk > 0
    ? roundMetric((firstTopAsk - lastTopAsk) / firstTopAsk)
    : null
  const bidDepthGrowthRatio = depthRatio(firstBidDepth, lastBidDepth)
  const askDepthGrowthRatio = depthRatio(firstAskDepth, lastAskDepth)
  let bestAskConsumedCount = 0
  for (let i = 1; i < clean.length; i += 1) {
    const prev = clean[i - 1]
    const curr = clean[i]
    const prevAsk = finitePositive(prev.bestAsk)
    const currAsk = finitePositive(curr.bestAsk)
    const prevTop = finiteMetric(prev.askVolumes[0]) ?? 0
    const currTop = finiteMetric(curr.askVolumes[0]) ?? 0
    if (prevAsk != null && currAsk != null && currAsk >= prevAsk && prevTop > 0 && currTop < prevTop) {
      bestAskConsumedCount += 1
    }
  }

  const metrics: L5OrderBookPersistence['metrics'] = {
    samples: clean.length,
    positiveImbalanceRatio,
    averageImbalance,
    averageSpreadPct,
    spreadCompressionPct,
    topAskVolumeDropRatio,
    bidDepthGrowthRatio,
    askDepthGrowthRatio,
    bestAskConsumedCount,
  }
  const failed: string[] = []
  if (positiveImbalanceRatio != null && positiveImbalanceRatio < thresholds.minPositiveImbalanceRatio) {
    failed.push('l5_imbalance_not_persistent')
  }
  if (averageImbalance != null && averageImbalance < thresholds.minAverageImbalance) {
    failed.push('l5_average_imbalance_weak')
  }
  if (averageSpreadPct != null && averageSpreadPct > thresholds.maxAverageSpreadPct) {
    failed.push('l5_average_spread_wide')
  }
  if (spreadCompressionPct != null && spreadCompressionPct < thresholds.minSpreadCompressionPct) {
    failed.push('l5_spread_not_compressing')
  }
  if (askDepthGrowthRatio != null && askDepthGrowthRatio > thresholds.maxAskDepthGrowthRatio) {
    failed.push('l5_ask_wall_growing')
  }

  const supportive = [
    positiveImbalanceRatio != null && positiveImbalanceRatio >= thresholds.minPositiveImbalanceRatio,
    averageImbalance != null && averageImbalance >= thresholds.minAverageImbalance,
    spreadCompressionPct != null && spreadCompressionPct >= thresholds.minSpreadCompressionPct,
    topAskVolumeDropRatio != null && topAskVolumeDropRatio >= thresholds.minTopAskVolumeDropRatio,
    bidDepthGrowthRatio != null && bidDepthGrowthRatio >= thresholds.minBidDepthGrowthRatio,
    bestAskConsumedCount > 0,
  ].filter(Boolean).length

  if (failed.includes('l5_average_spread_wide') || failed.includes('l5_average_imbalance_weak')) {
    return { status: 'degraded', reasons: failed, metrics }
  }
  if (failed.length > 0) {
    return { status: 'neutral', reasons: failed, metrics }
  }
  return {
    status: supportive >= 4 ? 'boost' : 'neutral',
    reasons: supportive >= 4 ? ['l5_persistent_bid_support'] : ['l5_persistence_neutral'],
    metrics,
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

function enabledUnlessExplicitlyFalse(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off', 'disabled'].includes(normalized)
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

function shioajiProxyFallbackEnabled(env: { SHIOAJI_PROXY_URL?: string; SHIOAJI_L5_PROXY_FALLBACK_ENABLED?: string }): boolean {
  return Boolean(env.SHIOAJI_PROXY_URL?.trim()) && enabledUnlessExplicitlyFalse(env.SHIOAJI_L5_PROXY_FALLBACK_ENABLED)
}

function proxyOrderbookQuoteFromPayload(symbol: string, payload: Record<string, unknown> | null | undefined): FinLabL5Quote | null {
  if (!payload) return null
  return normalizeFinLabL5Quote(symbol, {
    provider: 'shioaji_proxy_orderbook',
    status: payload.status ?? 'orderbook',
    price: payload.price,
    bid_prices: payload.bid_prices ?? payload.bidPrices,
    ask_prices: payload.ask_prices ?? payload.askPrices,
    bid_volumes: payload.bid_volumes ?? payload.bidVolumes,
    ask_volumes: payload.ask_volumes ?? payload.askVolumes,
    source_time: payload.updated_at ?? payload.timestamp,
  })
}

async function applyShioajiProxyL5Fallback(
  snapshot: FinLabL5MarketDataSnapshot,
  env: {
    SHIOAJI_PROXY_URL?: string
    PROXY_SERVICE_TOKEN?: string
    SHIOAJI_L5_PROXY_FALLBACK_ENABLED?: string
  },
  symbols: string[],
  fallbackReason: string,
): Promise<boolean> {
  if (!shioajiProxyFallbackEnabled(env)) return false

  const proxyUrl = String(env.SHIOAJI_PROXY_URL ?? '').replace(/\/+$/, '')
  const headers = env.PROXY_SERVICE_TOKEN ? { Authorization: `Bearer ${env.PROXY_SERVICE_TOKEN}` } : undefined
  const fallbackErrors: string[] = []
  let added = 0

  for (const symbol of symbols) {
    try {
      const res = await fetch(`${proxyUrl}/orderbook/${encodeURIComponent(symbol)}`, {
        headers,
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) {
        fallbackErrors.push(`${symbol}:http_${res.status}`)
        continue
      }
      const payload = await res.json() as Record<string, unknown>
      const quote = proxyOrderbookQuoteFromPayload(symbol, payload)
      const hasExecutableBook = quote?.bestBid != null && quote.bestAsk != null && quote.bidPrices.length > 0 && quote.askPrices.length > 0
      if (!quote || !hasExecutableBook) {
        fallbackErrors.push(`${symbol}:${String(payload?.status ?? 'missing_depth')}`)
        continue
      }
      snapshot.quotes.set(symbol, quote)
      added += 1
    } catch (error) {
      fallbackErrors.push(`${symbol}:${error instanceof Error ? error.message : String(error)}`.slice(0, 240))
    }
  }

  const fallbackUsed = added > 0
  snapshot.raw = {
    ...(snapshot.raw ?? {}),
    source: fallbackUsed ? 'worker_shioaji_proxy_orderbook_fallback' : snapshot.raw?.source,
    fallback_attempted: true,
    fallback_used: fallbackUsed,
    fallback_reason: fallbackReason,
    fallback_errors: fallbackErrors,
  }
  if (fallbackUsed) {
    snapshot.status = 'pass'
    snapshot.blockedReasons = []
    snapshot.liveSubmitEnabled = false
    snapshot.canSubmitRealOrder = false
  }
  return fallbackUsed
}

export async function fetchFinLabL5MarketDataSnapshot(
  env: {
    ML_CONTROLLER_URL?: string
    ML_CONTROLLER_SECRET?: string
    FINLAB_L5_MARKET_DATA_ENABLED?: string
    FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN?: string
    SHIOAJI_PROXY_URL?: string
    PROXY_SERVICE_TOKEN?: string
    SHIOAJI_L5_PROXY_FALLBACK_ENABLED?: string
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
    if (!res.ok) {
      const failed = emptyL5MarketDataSnapshot(`http_${res.status}`)
      await applyShioajiProxyL5Fallback(failed, env, symbols, `controller_http_${res.status}`)
      return failed
    }
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
        source: payload.source,
        blocked_reasons: payload.blocked_reasons,
        env_status: payload.env_status,
        fallback_used: payload.fallback_used,
        fallback_attempted: payload.fallback_attempted,
        fallback_reason: payload.fallback_reason,
        fallback_errors: payload.fallback_errors,
        error_type: payload.error_type,
        error: payload.error,
        account_error_type: payload.account_error_type,
        account_error: payload.account_error,
      }
      : null
    if (snapshot.canSubmitRealOrder || snapshot.liveSubmitEnabled) return snapshot
    const quotes = payload?.quotes && typeof payload.quotes === 'object' ? payload.quotes : {}
    for (const [symbol, quotePayload] of Object.entries(quotes)) {
      const quote = normalizeFinLabL5Quote(symbol, quotePayload as Record<string, unknown>)
      if (quote) snapshot.quotes.set(symbol, quote)
    }
    if (snapshot.quotes.size === 0) {
      await applyShioajiProxyL5Fallback(
        snapshot,
        env,
        symbols,
        snapshot.status ? `controller_${snapshot.status}` : 'controller_empty_quotes',
      )
    }
  } catch (error) {
    console.warn(`[FinLabL5MarketData] fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    const failed = emptyL5MarketDataSnapshot('fetch_failed')
    await applyShioajiProxyL5Fallback(failed, env, symbols, 'controller_fetch_failed')
    return failed
  }
  return snapshot
}

export async function fetchFinLabL5MarketDataQuotes(
  env: {
    ML_CONTROLLER_URL?: string
    ML_CONTROLLER_SECRET?: string
    FINLAB_L5_MARKET_DATA_ENABLED?: string
    FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN?: string
    SHIOAJI_PROXY_URL?: string
    PROXY_SERVICE_TOKEN?: string
    SHIOAJI_L5_PROXY_FALLBACK_ENABLED?: string
  },
  symbols: string[],
): Promise<Map<string, FinLabL5Quote>> {
  const snapshot = await fetchFinLabL5MarketDataSnapshot(env, symbols)
  return snapshot.quotes
}
