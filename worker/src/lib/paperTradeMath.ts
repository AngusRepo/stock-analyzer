import type { TradingConfig } from './tradingConfig'

export function calcCommission(value: number, cfg: TradingConfig): number {
  return Math.max(Math.round(value * cfg.fees.commission), cfg.fees.minCommission)
}

export function getTickSize(price: number): number {
  return price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5
}

export function applySlippage(price: number, side: 'buy' | 'sell', ticks = 1, dailyTurnover?: number): number {
  const tickSize = getTickSize(price)
  let extraTicks = 0
  if (dailyTurnover != null && dailyTurnover > 0) {
    if (dailyTurnover < 10_000_000) extraTicks = 3
    else if (dailyTurnover < 50_000_000) extraTicks = 1
  }
  const slippage = tickSize * (ticks + extraTicks)
  return side === 'buy' ? price + slippage : Math.max(price - slippage, tickSize)
}

export interface LimitBuyFillInput {
  currentPrice: number
  limitPrice: number
  bestAsk?: number | null
  bestBid?: number | null
  intradayLow?: number | null
  intradayHigh?: number | null
  slippageTicks?: number
  requireBestAsk?: boolean
}

export interface LimitBuyFillResult {
  fillable: boolean
  fillPrice?: number
  reason: string
}

export interface LimitSellFillInput {
  currentPrice: number
  limitPrice: number
  bestBid?: number | null
  bestAsk?: number | null
  intradayLow?: number | null
  intradayHigh?: number | null
  slippageTicks?: number
  requireBestBid?: boolean
}

export interface LimitSellFillResult {
  fillable: boolean
  fillPrice?: number
  reason: string
}

export interface MarketSellFillInput {
  currentPrice: number
  bestBid?: number | null
  bestAsk?: number | null
  intradayLow?: number | null
  intradayHigh?: number | null
  slippageTicks?: number
  requireBestBid?: boolean
}

export interface MarketSellFillResult {
  fillable: boolean
  fillPrice?: number
  reason: string
}

export function resolveLimitBuyFill(input: LimitBuyFillInput): LimitBuyFillResult {
  const currentPrice = Number(input.currentPrice)
  const limitPrice = Number(input.limitPrice)
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return { fillable: false, reason: 'invalid_current_price' }
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return { fillable: false, reason: 'invalid_limit_price' }

  const low = input.intradayLow == null ? null : Number(input.intradayLow)
  const high = input.intradayHigh == null ? null : Number(input.intradayHigh)
  if (low != null && high != null && Number.isFinite(low) && Number.isFinite(high) && low > high) {
    return {
      fillable: false,
      reason: `invalid_intraday_range:low_${low.toFixed(2)}_gt_high_${high.toFixed(2)}`,
    }
  }
  if (low != null && Number.isFinite(low) && low > limitPrice) {
    return {
      fillable: false,
      reason: `limit_not_touched:low_${low.toFixed(2)}_gt_limit_${limitPrice.toFixed(2)}`,
    }
  }

  const bestAsk = input.bestAsk == null ? null : Number(input.bestAsk)
  if (input.requireBestAsk && (bestAsk == null || !Number.isFinite(bestAsk) || bestAsk <= 0)) {
    return { fillable: false, reason: 'missing_best_ask' }
  }
  if (bestAsk != null && Number.isFinite(bestAsk) && bestAsk > limitPrice) {
    return {
      fillable: false,
      reason: `ask_above_limit:${bestAsk.toFixed(2)}_gt_${limitPrice.toFixed(2)}`,
    }
  }

  if (currentPrice > limitPrice && bestAsk == null && (low == null || !Number.isFinite(low))) {
    return {
      fillable: false,
      reason: `price_above_limit:${currentPrice.toFixed(2)}_gt_${limitPrice.toFixed(2)}`,
    }
  }

  const referencePrice =
    bestAsk != null && Number.isFinite(bestAsk) && bestAsk <= limitPrice
      ? bestAsk
      : currentPrice <= limitPrice
        ? currentPrice
        : limitPrice
  const slippedPrice = applySlippage(referencePrice, 'buy', input.slippageTicks ?? 1)
  const fillPrice = Math.round(Math.min(limitPrice, slippedPrice) * 100) / 100
  if (low != null && Number.isFinite(low) && fillPrice < low) {
    return {
      fillable: false,
      reason: `fill_below_intraday_low:${fillPrice.toFixed(2)}_lt_${low.toFixed(2)}`,
    }
  }
  if (high != null && Number.isFinite(high) && fillPrice > high) {
    return {
      fillable: false,
      reason: `fill_above_intraday_high:${fillPrice.toFixed(2)}_gt_${high.toFixed(2)}`,
    }
  }
  return {
    fillable: true,
    fillPrice,
    reason: currentPrice <= limitPrice ? 'marketable_limit' : 'limit_touched_intraday',
  }
}

export function resolveLimitSellFill(input: LimitSellFillInput): LimitSellFillResult {
  const currentPrice = Number(input.currentPrice)
  const limitPrice = Number(input.limitPrice)
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return { fillable: false, reason: 'invalid_current_price' }
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) return { fillable: false, reason: 'invalid_limit_price' }

  const low = input.intradayLow == null ? null : Number(input.intradayLow)
  const high = input.intradayHigh == null ? null : Number(input.intradayHigh)
  if (low != null && high != null && Number.isFinite(low) && Number.isFinite(high) && low > high) {
    return {
      fillable: false,
      reason: `invalid_intraday_range:low_${low.toFixed(2)}_gt_high_${high.toFixed(2)}`,
    }
  }
  if (high != null && Number.isFinite(high) && high < limitPrice) {
    return {
      fillable: false,
      reason: `limit_not_touched:high_${high.toFixed(2)}_lt_limit_${limitPrice.toFixed(2)}`,
    }
  }

  const bestBid = input.bestBid == null ? null : Number(input.bestBid)
  if (input.requireBestBid && (bestBid == null || !Number.isFinite(bestBid) || bestBid <= 0)) {
    return { fillable: false, reason: 'missing_best_bid' }
  }
  if (bestBid != null && Number.isFinite(bestBid) && bestBid < limitPrice) {
    return {
      fillable: false,
      reason: `bid_below_limit:${bestBid.toFixed(2)}_lt_${limitPrice.toFixed(2)}`,
    }
  }

  if (currentPrice < limitPrice && bestBid == null && (high == null || !Number.isFinite(high))) {
    return {
      fillable: false,
      reason: `price_below_limit:${currentPrice.toFixed(2)}_lt_${limitPrice.toFixed(2)}`,
    }
  }

  const referencePrice =
    bestBid != null && Number.isFinite(bestBid) && bestBid >= limitPrice
      ? bestBid
      : currentPrice >= limitPrice
        ? currentPrice
        : limitPrice
  const slippedPrice = applySlippage(referencePrice, 'sell', input.slippageTicks ?? 1)
  const fillPrice = Math.round(Math.max(limitPrice, slippedPrice) * 100) / 100
  if (low != null && Number.isFinite(low) && fillPrice < low) {
    return {
      fillable: false,
      reason: `fill_below_intraday_low:${fillPrice.toFixed(2)}_lt_${low.toFixed(2)}`,
    }
  }
  if (high != null && Number.isFinite(high) && fillPrice > high) {
    return {
      fillable: false,
      reason: `fill_above_intraday_high:${fillPrice.toFixed(2)}_gt_${high.toFixed(2)}`,
    }
  }
  return {
    fillable: true,
    fillPrice,
    reason: currentPrice >= limitPrice ? 'marketable_limit' : 'limit_touched_intraday',
  }
}

export function resolveMarketSellFill(input: MarketSellFillInput): MarketSellFillResult {
  const currentPrice = Number(input.currentPrice)
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return { fillable: false, reason: 'invalid_current_price' }

  const low = input.intradayLow == null ? null : Number(input.intradayLow)
  const high = input.intradayHigh == null ? null : Number(input.intradayHigh)
  if (low != null && high != null && Number.isFinite(low) && Number.isFinite(high) && low > high) {
    return {
      fillable: false,
      reason: `invalid_intraday_range:low_${low.toFixed(2)}_gt_high_${high.toFixed(2)}`,
    }
  }

  const bestBid = input.bestBid == null ? null : Number(input.bestBid)
  if (input.requireBestBid && (bestBid == null || !Number.isFinite(bestBid) || bestBid <= 0)) {
    return { fillable: false, reason: 'missing_best_bid' }
  }
  const referencePrice = bestBid != null && Number.isFinite(bestBid) && bestBid > 0 ? bestBid : currentPrice
  const fillPrice = Math.round(applySlippage(referencePrice, 'sell', input.slippageTicks ?? 1) * 100) / 100
  if (low != null && Number.isFinite(low) && fillPrice < low) {
    return {
      fillable: false,
      reason: `fill_below_intraday_low:${fillPrice.toFixed(2)}_lt_${low.toFixed(2)}`,
    }
  }
  if (high != null && Number.isFinite(high) && fillPrice > high) {
    return {
      fillable: false,
      reason: `fill_above_intraday_high:${fillPrice.toFixed(2)}_gt_${high.toFixed(2)}`,
    }
  }
  return {
    fillable: true,
    fillPrice,
    reason: bestBid != null && Number.isFinite(bestBid) && bestBid > 0 ? 'broker_bid_market_sell' : 'last_price_fallback_market_sell',
  }
}

export function applyPartialFill(shares: number, price: number, dailyVolume: number, cfg?: TradingConfig): number {
  if (dailyVolume <= 0) return shares
  const orderVolume = shares * price
  const dailyValue = dailyVolume * price
  const pctOfDaily = orderVolume / dailyValue
  const partialFillThreshold = cfg?.position?.partialFillThreshold ?? 0.05
  const partialFillRate = cfg?.position?.partialFillRate ?? 0.2

  if (pctOfDaily > partialFillThreshold) {
    const maxFillValue = dailyValue * partialFillThreshold
    const excessShares = Math.max(0, shares - Math.floor(maxFillValue / price))
    const filledShares = shares - Math.floor(excessShares * partialFillRate)
    console.log(`[PartialFill] Order ${shares} shares = ${(pctOfDaily * 100).toFixed(1)}% of daily vol -> filled ${filledShares}`)
    return Math.max(1, filledShares)
  }

  return shares
}

export function isLimitDownLocked(
  currentPrice: number,
  prevClose: number,
  volume: number,
  prevVolume: number,
  cfg?: TradingConfig,
): boolean {
  if (prevClose <= 0) return false
  const dropPct = (currentPrice - prevClose) / prevClose
  const volRatio = prevVolume > 0 ? volume / prevVolume : 1
  const dropThresh = cfg?.circuit?.lockedDropPct ?? -0.095
  const volThresh = cfg?.circuit?.lockedVolRatio ?? 0.1
  return dropPct <= dropThresh && volRatio < volThresh
}

export function calcTax(value: number, cfg: TradingConfig, isDayTrade = false): number {
  const rate = isDayTrade ? cfg.fees.dayTradeTax : cfg.fees.tax
  return Math.round(value * rate)
}
