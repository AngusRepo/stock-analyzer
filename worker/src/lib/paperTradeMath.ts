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
  intradayLow?: number | null
  slippageTicks?: number
}

export interface LimitBuyFillResult {
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
  if (low != null && Number.isFinite(low) && low > limitPrice) {
    return {
      fillable: false,
      reason: `limit_not_touched:low_${low.toFixed(2)}_gt_limit_${limitPrice.toFixed(2)}`,
    }
  }

  if (currentPrice > limitPrice && (low == null || !Number.isFinite(low))) {
    return {
      fillable: false,
      reason: `price_above_limit:${currentPrice.toFixed(2)}_gt_${limitPrice.toFixed(2)}`,
    }
  }

  const referencePrice = currentPrice <= limitPrice ? currentPrice : limitPrice
  const slippedPrice = applySlippage(referencePrice, 'buy', input.slippageTicks ?? 1)
  return {
    fillable: true,
    fillPrice: Math.round(Math.min(limitPrice, slippedPrice) * 100) / 100,
    reason: currentPrice <= limitPrice ? 'marketable_limit' : 'limit_touched_intraday',
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
