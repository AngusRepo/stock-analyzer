import { buildTwOrderLegs, getTwTickSize, normalizeTwLimitPrice, type TwOrderLeg } from './twMarketRules'

export interface OrderIntentPendingBuy {
  symbol: string
  confidence: number
  risk_pct: number
  kelly_pct?: number | null
}

export interface StockVisionOrderIntent {
  schemaVersion: 'stockvision-order-intent-v1'
  accountId: number
  tradeDate: string
  symbol: string
  side: 'buy' | 'sell'
  maxBudget: number
  maxPrice: number
  minPrice?: number | null
  limitPrice: number
  priceRole: 'buy_max' | 'sell_min'
  priceTick: number
  priceSnapMode: 'floor_to_buy_limit' | 'ceil_to_sell_limit'
  requestedShares: number
  orderLegs: TwOrderLeg[]
  strategyType: string
  timeInForce: 'ROD'
  liveSubmitRequested: false
  riskContext: {
    marketRiskLevel: string
    confidence: number
    riskPct: number
    kellyPct?: number | null
  }
  executionConstraints: {
    quoteSource: string
    quoteAgeMs?: number | null
    maxEntryChasePct: number
    minVolumeRatio?: number | null
    minRangePosition?: number | null
    bestBid?: number | null
    bestAsk?: number | null
  }
}

export interface BuildStockVisionOrderIntentInput {
  accountId: number
  tradeDate: string
  pending: OrderIntentPendingBuy
  limitPrice: number
  currentPrice: number
  budget: number
  shares: number
  strategyMode?: string | null
  marketRiskLevel?: string | null
  quote: {
    bestBid?: number | null
    bestAsk?: number | null
    source?: string | null
    quoteAgeMs?: number | null
  }
  adaptivePolicy: {
    maxEntryChasePct: number
    minVolumeRatio?: number | null
    minRangePosition?: number | null
  }
}

export interface BuildStockVisionSellOrderIntentInput {
  accountId: number
  tradeDate: string
  symbol: string
  limitPrice: number
  currentPrice: number
  shares: number
  reason?: string | null
  strategyType?: string | null
  marketRiskLevel?: string | null
  quote: {
    bestBid?: number | null
    bestAsk?: number | null
    source?: string | null
    quoteAgeMs?: number | null
  }
}

function finitePositive(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function buildStockVisionOrderIntent(input: BuildStockVisionOrderIntentInput): StockVisionOrderIntent {
  const rawMaxPrice = finitePositive(input.limitPrice, input.currentPrice)
  const maxPrice = normalizeTwLimitPrice(rawMaxPrice, 'buy')
  const requestedShares = Math.max(0, Math.floor(finitePositive(input.shares)))

  return {
    schemaVersion: 'stockvision-order-intent-v1',
    accountId: input.accountId,
    tradeDate: input.tradeDate,
    symbol: input.pending.symbol,
    side: 'buy',
    maxBudget: Math.round(finitePositive(input.budget)),
    maxPrice,
    minPrice: null,
    limitPrice: maxPrice,
    priceRole: 'buy_max',
    priceTick: getTwTickSize(maxPrice),
    priceSnapMode: 'floor_to_buy_limit',
    requestedShares,
    orderLegs: buildTwOrderLegs(requestedShares),
    strategyType: String(input.strategyMode || 'trend'),
    timeInForce: 'ROD',
    liveSubmitRequested: false,
    riskContext: {
      marketRiskLevel: String(input.marketRiskLevel || 'unknown'),
      confidence: Number(input.pending.confidence ?? 0),
      riskPct: Number(input.pending.risk_pct ?? 0),
      kellyPct: input.pending.kelly_pct ?? null,
    },
    executionConstraints: {
      quoteSource: String(input.quote.source || 'none'),
      quoteAgeMs: input.quote.quoteAgeMs ?? null,
      maxEntryChasePct: Number(input.adaptivePolicy.maxEntryChasePct ?? 0),
      minVolumeRatio: input.adaptivePolicy.minVolumeRatio ?? null,
      minRangePosition: input.adaptivePolicy.minRangePosition ?? null,
      bestBid: input.quote.bestBid ?? null,
      bestAsk: input.quote.bestAsk ?? null,
    },
  }
}

export function buildStockVisionSellOrderIntent(input: BuildStockVisionSellOrderIntentInput): StockVisionOrderIntent {
  const rawMinPrice = finitePositive(input.limitPrice, input.currentPrice)
  const minPrice = normalizeTwLimitPrice(rawMinPrice, 'sell')
  const requestedShares = Math.max(0, Math.floor(finitePositive(input.shares)))

  return {
    schemaVersion: 'stockvision-order-intent-v1',
    accountId: input.accountId,
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    side: 'sell',
    maxBudget: 0,
    maxPrice: minPrice,
    minPrice,
    limitPrice: minPrice,
    priceRole: 'sell_min',
    priceTick: getTwTickSize(minPrice),
    priceSnapMode: 'ceil_to_sell_limit',
    requestedShares,
    orderLegs: buildTwOrderLegs(requestedShares),
    strategyType: String(input.strategyType || 'exit'),
    timeInForce: 'ROD',
    liveSubmitRequested: false,
    riskContext: {
      marketRiskLevel: String(input.marketRiskLevel || 'unknown'),
      confidence: 0,
      riskPct: 0,
      kellyPct: null,
    },
    executionConstraints: {
      quoteSource: String(input.quote.source || 'none'),
      quoteAgeMs: input.quote.quoteAgeMs ?? null,
      maxEntryChasePct: 0,
      minVolumeRatio: null,
      minRangePosition: null,
      bestBid: input.quote.bestBid ?? null,
      bestAsk: input.quote.bestAsk ?? null,
    },
  }
}
