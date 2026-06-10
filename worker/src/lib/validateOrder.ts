import type { RiskConfig } from './riskConfig'
import type { OrderValidation, OrderViolation } from './riskTypes'
import { buildTwOrderLegs, isValidTwTickPrice, normalizeTwLimitPrice } from './twMarketRules'

export interface ValidateOrderInput {
  symbol: string
  side: 'buy' | 'sell'
  shares: number
  limitPrice: number
  refClose: number | null
  avgVolume20d: number | null
}

export async function validateOrder(
  input: ValidateOrderInput,
  riskCfg: RiskConfig,
): Promise<OrderValidation> {
  const { order } = riskCfg
  const violations: OrderViolation[] = []
  const requestedShares = Math.max(0, Math.floor(Number(input.shares) || 0))
  let adjShares = requestedShares
  const adjPrice = normalizeTwLimitPrice(input.limitPrice, input.side)
  const adjustReasons: string[] = []

  if (!Number.isFinite(adjPrice) || adjPrice <= 0) {
    violations.push({
      gate: 'G6',
      severity: 'block',
      message: 'invalid TW limit price',
      requestedValue: input.limitPrice,
      allowedValue: 0,
    })
  } else if (!isValidTwTickPrice(input.limitPrice)) {
    adjustReasons.push(`TW tick normalize ${input.limitPrice} -> ${adjPrice}`)
    violations.push({
      gate: 'G6',
      severity: 'adjust',
      message: `limit price normalized to TW tick: ${input.limitPrice} -> ${adjPrice}`,
      requestedValue: input.limitPrice,
      allowedValue: adjPrice,
    })
  }

  if (requestedShares <= 0) {
    violations.push({
      gate: 'G7',
      severity: 'block',
      message: `invalid TW order shares: ${input.shares}`,
      requestedValue: input.shares,
      allowedValue: 1,
    })
  }

  const orderValue = requestedShares * adjPrice
  if (orderValue > order.maxSingleOrderValue) {
    violations.push({
      gate: 'G5',
      severity: 'block',
      message: `single order value ${orderValue.toFixed(0)} exceeds cap ${order.maxSingleOrderValue}`,
      requestedValue: orderValue,
      allowedValue: order.maxSingleOrderValue,
    })
  }

  if (input.refClose && input.refClose > 0) {
    const dev = Math.abs((adjPrice - input.refClose) / input.refClose)
    if (dev > order.maxPriceDeviationPct) {
      violations.push({
        gate: 'G6',
        severity: 'block',
        message: `limit price deviation ${(dev * 100).toFixed(1)}% > ${(order.maxPriceDeviationPct * 100).toFixed(1)}%`,
        requestedValue: adjPrice,
        allowedValue: input.refClose * (1 + order.maxPriceDeviationPct),
      })
    }
  }

  if (order.enforceRegularLots && requestedShares > 0 && buildTwOrderLegs(requestedShares).length === 0) {
    violations.push({
      gate: 'G7',
      severity: 'block',
      message: `unable to split shares into TW order legs: ${requestedShares}`,
      requestedValue: requestedShares,
      allowedValue: 1,
    })
  }

  if (input.avgVolume20d && input.avgVolume20d > 0) {
    const cap = Math.floor(input.avgVolume20d * order.maxVolumeParticipation)
    if (requestedShares > cap && cap >= 1) {
      adjShares = Math.min(adjShares, cap)
      adjustReasons.push(`G14 cap to ${cap} shares (${(order.maxVolumeParticipation * 100).toFixed(1)}% of 20d avg volume)`)
      violations.push({
        gate: 'G14',
        severity: 'adjust',
        message: `shares ${requestedShares} > 20d volume participation cap ${cap}`,
        requestedValue: requestedShares,
        allowedValue: cap,
      })
    } else if (cap < 1) {
      violations.push({
        gate: 'G14',
        severity: 'block',
        message: `20d average volume ${input.avgVolume20d} leaves no tradeable participation capacity`,
        requestedValue: requestedShares,
        allowedValue: cap,
      })
    }
  }

  const blocked = violations.some((v) => v.severity === 'block')
  const adjusted = !blocked && adjustReasons.length > 0

  return {
    approved: !blocked,
    violations,
    adjustedOrder: adjusted
      ? {
          shares: adjShares,
          limitPrice: adjPrice,
          adjustmentReasons: adjustReasons,
        }
      : null,
    checkedAt: new Date().toISOString(),
  }
}
