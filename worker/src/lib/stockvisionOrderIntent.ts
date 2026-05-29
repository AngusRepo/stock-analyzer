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
  side: 'buy'
  maxBudget: number
  maxPrice: number
  requestedShares: number
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

function finitePositive(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100
}

export function buildStockVisionOrderIntent(input: BuildStockVisionOrderIntentInput): StockVisionOrderIntent {
  return {
    schemaVersion: 'stockvision-order-intent-v1',
    accountId: input.accountId,
    tradeDate: input.tradeDate,
    symbol: input.pending.symbol,
    side: 'buy',
    maxBudget: Math.round(finitePositive(input.budget)),
    maxPrice: roundPrice(finitePositive(input.limitPrice, input.currentPrice)),
    requestedShares: Math.max(0, Math.floor(finitePositive(input.shares))),
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
