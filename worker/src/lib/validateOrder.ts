/**
 * validateOrder.ts — Level 4 per-order gates (2026-04-21 R3)
 *
 * Last check before execute. R3 minimum set:
 *   G5  Fat finger (single-order NT$ cap)
 *   G6  Price deviation (limit price vs ref close)
 *   G7  Lot size (台股 1000-share integer)
 *   G14 Liquidity (participation vs 20d avg volume)
 *
 * Deferred to R3b:
 *   G8  T+2 settlement cash availability
 *   G11 Cooldown (exists in paper.ts morning-setup already)
 *   G12 Punished stock (exists in marketScreener already)
 *   G13 Limit-up lock (runtime detection, hard to pre-validate)
 */
import type { RiskConfig } from './riskConfig'
import type { OrderValidation, OrderViolation } from './riskTypes'

export interface ValidateOrderInput {
  symbol: string
  side: 'buy' | 'sell'
  shares: number
  limitPrice: number
  refClose: number | null       // previous close or last print
  avgVolume20d: number | null   // shares
}

export async function validateOrder(
  input: ValidateOrderInput,
  riskCfg: RiskConfig,
): Promise<OrderValidation> {
  const { order } = riskCfg
  const violations: OrderViolation[] = []
  let adjShares = input.shares
  let adjPrice = input.limitPrice
  const adjustReasons: string[] = []

  // G5 fat finger — value cap
  const orderValue = input.shares * input.limitPrice
  if (orderValue > order.maxSingleOrderValue) {
    violations.push({
      gate: 'G5',
      severity: 'block',
      message: `單筆 ${orderValue.toFixed(0)} 超過上限 ${order.maxSingleOrderValue}`,
      requestedValue: orderValue,
      allowedValue: order.maxSingleOrderValue,
    })
  }

  // G6 price deviation from ref
  if (input.refClose && input.refClose > 0) {
    const dev = Math.abs((input.limitPrice - input.refClose) / input.refClose)
    if (dev > order.maxPriceDeviationPct) {
      violations.push({
        gate: 'G6',
        severity: 'block',
        message: `限價偏離參考價 ${(dev * 100).toFixed(1)}% > ${(order.maxPriceDeviationPct * 100).toFixed(1)}%`,
        requestedValue: input.limitPrice,
        allowedValue: input.refClose * (1 + order.maxPriceDeviationPct),
      })
    }
  }

  // G7 lot size — 台股整股 1000 shares (零股獨立市場不在此)
  if (order.enforceRegularLots && input.shares % 1000 !== 0) {
    const rounded = Math.floor(input.shares / 1000) * 1000
    if (rounded <= 0) {
      violations.push({
        gate: 'G7',
        severity: 'block',
        message: `非整張單 ${input.shares} 股，低於最小整張 1000 股`,
        requestedValue: input.shares,
        allowedValue: 1000,
      })
    } else {
      adjShares = rounded
      adjustReasons.push(`G7 round to ${rounded} shares`)
      violations.push({
        gate: 'G7',
        severity: 'adjust',
        message: `shares rounded down to integer lots: ${input.shares} → ${rounded}`,
        requestedValue: input.shares,
        allowedValue: rounded,
      })
    }
  }

  // G14 liquidity participation — no single order > 5% of 20d avg volume
  if (input.avgVolume20d && input.avgVolume20d > 0) {
    const cap = Math.floor(input.avgVolume20d * order.maxVolumeParticipation / 1000) * 1000
    if (input.shares > cap && cap >= 1000) {
      adjShares = Math.min(adjShares, cap)
      adjustReasons.push(`G14 cap to ${cap} shares (${(order.maxVolumeParticipation * 100).toFixed(1)}% of 20d avg vol)`)
      violations.push({
        gate: 'G14',
        severity: 'adjust',
        message: `單筆 ${input.shares} > 20d 均量參與率上限 ${cap}`,
        requestedValue: input.shares,
        allowedValue: cap,
      })
    } else if (cap < 1000) {
      // 20d avg vol < 20k shares → unusable liquidity, block
      violations.push({
        gate: 'G14',
        severity: 'block',
        message: `流動性不足：20d 均量 ${input.avgVolume20d} → 參與率上限 ${cap} < 1 整張`,
        requestedValue: input.shares,
        allowedValue: cap,
      })
    }
  }

  const blocked = violations.some(v => v.severity === 'block')
  const adjusted = !blocked && adjustReasons.length > 0

  return {
    approved: !blocked,
    violations,
    adjustedOrder: adjusted ? {
      shares: adjShares,
      limitPrice: adjPrice,
      adjustmentReasons: adjustReasons,
    } : null,
    checkedAt: new Date().toISOString(),
  }
}
