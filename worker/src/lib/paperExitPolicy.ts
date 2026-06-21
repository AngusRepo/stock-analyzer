import { getExitMultiplier, type MarketRegime } from './dynamicExitPriority'
import type { TradingConfig } from './tradingConfig'

export interface ExitPosition {
  symbol: string
  shares: number
  avg_cost: number
  entry_price: number | null
  initial_stop: number | null
  trailing_stop: number | null
  highest_since_entry: number | null
  tp1_price: number | null
  tp2_price: number | null
  tp1_hit: number
  original_shares: number | null
  entry_date: string | null
  stop_multiplier: number | null
}

export interface ExitDecision {
  action: 'full_sell' | 'partial_sell' | 'hold'
  reason: string
  sellShares?: number
  newTrailingStop?: number
  newHighest?: number
  newTp2Price?: number
  moveStopToEntry?: boolean
}

export function categorizeExitReason(reason: string): string {
  if (reason.includes('Hard stop') || reason.includes('HardStop') || reason.includes('蝖砌')) return 'HardStop'
  if (reason.includes('ATR 初始停損') || reason.includes('InitStop') || reason.includes('ATR')) return 'InitStop'
  if (reason.includes('Trailing Stop') || reason.includes('TrailStop')) return 'TrailStop'
  if (reason.includes('ML SELL')) return 'ML_SELL'
  if (reason.includes('TP2')) return 'TP2'
  if (reason.includes('TP1')) return 'TP1'
  if (reason.includes('Time stop') || reason.includes('TimeStop') || reason.includes('持有天數')) return 'TimeStop'
  if (reason.includes('trailing update')) return 'HoldTrailingUpdate'
  return 'HoldNoTrigger'
}

export function checkExitConditions(
  pos: ExitPosition,
  currentPrice: number,
  atr14: number,
  hasMlSell: boolean,
  isEOD: boolean,
  cfg: TradingConfig,
  resolvedSltp?: TradingConfig['sltp'],
  regime?: MarketRegime,
): ExitDecision {
  const ex = cfg.exit
  const sltp = resolvedSltp ?? cfg.sltp
  const entryPrice = pos.entry_price ?? pos.avg_cost
  const pnlPct = (currentPrice - entryPrice) / entryPrice

  const useRegime = Boolean(ex.dynamicExitPriorityEnabled && regime)
  const mHardStop = useRegime ? getExitMultiplier(regime!, 'hardStop') : 1.0
  const mAtrTrail = useRegime ? getExitMultiplier(regime!, 'atrTrail') : 1.0
  const mMlSell = useRegime ? getExitMultiplier(regime!, 'mlSell') : 1.0
  const mTp1 = useRegime ? getExitMultiplier(regime!, 'tp1') : 1.0
  const mTp2 = useRegime ? getExitMultiplier(regime!, 'tp2') : 1.0
  const mTimeStop = useRegime ? getExitMultiplier(regime!, 'timeStop') : 1.0
  void mMlSell
  void mTp1
  void mTp2
  void mTimeStop

  const effHardStopPct = ex.hardStopPct / mHardStop
  if (pnlPct <= effHardStopPct) {
    return {
      action: 'full_sell',
      reason: `Hard stop ${(pnlPct * 100).toFixed(1)}%${useRegime ? ` [regime=${regime} x${mHardStop}]` : ''}`,
    }
  }

  const initStopRaw = pos.initial_stop ?? entryPrice * ex.fallbackInitStopMult
  const effInitStop = entryPrice - (entryPrice - initStopRaw) / mAtrTrail
  if (currentPrice <= effInitStop) {
    return {
      action: 'full_sell',
      reason: `ATR 初始停損 @ ${effInitStop.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%${useRegime ? ` [regime=${regime} x${mAtrTrail}]` : ''}`,
    }
  }

  if (isEOD && hasMlSell) {
    return { action: 'full_sell', reason: 'ML SELL' }
  }

  const trailingStopRaw = pos.trailing_stop ?? initStopRaw
  const effTrailingStop = entryPrice - (entryPrice - trailingStopRaw) / mAtrTrail
  if (currentPrice <= effTrailingStop && effTrailingStop > effInitStop) {
    return {
      action: 'full_sell',
      reason: `Trailing Stop @ ${effTrailingStop.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%${useRegime ? ` [regime=${regime} x${mAtrTrail}]` : ''}`,
    }
  }

  const initStop = initStopRaw
  void trailingStopRaw

  const tp1 = pos.tp1_price ?? entryPrice * ex.fallbackTp1Mult
  if (currentPrice >= tp1 && !pos.tp1_hit) {
    const sellShares = Math.floor(((pos.original_shares ?? pos.shares) * ex.tp1SellRatio) / 1000) * 1000
    if (sellShares > 0 && sellShares < pos.shares) {
      return {
        action: 'partial_sell',
        reason: `TP1 take profit @ ${currentPrice.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%`,
        sellShares,
        moveStopToEntry: true,
      }
    }

    return { action: 'full_sell', reason: `TP1 full exit @ ${currentPrice.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%` }
  }

  const highestSoFar = Math.max(pos.highest_since_entry ?? entryPrice, currentPrice)
  const trailSwitch3 = sltp?.trailSwitch3pct ?? 0.03
  const trailSwitch8 = sltp?.trailSwitch8pct ?? 0.08

  let trailMult = ex.trailMultDefault
  if (pnlPct > trailSwitch8) trailMult = ex.trailMultAt8pct
  else if (pnlPct > trailSwitch3) trailMult = ex.trailMultAt3pct

  const effectiveAtr = atr14 > 0 ? atr14 : currentPrice * ex.fallbackAtrPct
  const tp2 = pos.tp2_price ?? entryPrice * ex.fallbackTp2Mult
  const previousHighest = pos.highest_since_entry ?? entryPrice
  const tp2ExtensionMult = Math.max(0.5, (sltp?.tp2DistanceMultiplier ?? 2.0) / 2)
  const movingTp2 = pos.tp1_hit
    ? Math.max(tp2, highestSoFar + effectiveAtr * tp2ExtensionMult)
    : tp2
  const shouldMoveTp2 = Boolean(pos.tp1_hit && movingTp2 > tp2 && highestSoFar > previousHighest)

  if (currentPrice >= tp2 && pos.tp1_hit && !shouldMoveTp2) {
    return { action: 'full_sell', reason: `TP2 take profit @ ${currentPrice.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%` }
  }

  if (isEOD && pos.entry_date) {
    const daysSinceEntry = Math.floor((Date.now() - new Date(pos.entry_date).getTime()) / 86400000)
    if (daysSinceEntry > ex.timeStopDays && pnlPct > ex.timeStopMinProfit) {
      return { action: 'full_sell', reason: `Time stop ${daysSinceEntry}d +${(pnlPct * 100).toFixed(1)}%` }
    }
  }

  const newTrailing = highestSoFar - effectiveAtr * trailMult
  const floorStop = pos.tp1_hit ? entryPrice : initStop
  const finalTrailing = Math.max(newTrailing, floorStop)
  const prevTrailing = pos.trailing_stop ?? initStop
  const updatedTrailing = Math.max(finalTrailing, prevTrailing)

  if (updatedTrailing !== prevTrailing || highestSoFar !== previousHighest || shouldMoveTp2) {
    return {
      action: 'hold',
      reason: shouldMoveTp2 ? 'trailing update; moving TP2 update' : 'trailing update',
      newTrailingStop: updatedTrailing,
      newHighest: highestSoFar,
      newTp2Price: shouldMoveTp2 ? movingTp2 : undefined,
    }
  }

  return { action: 'hold', reason: 'no trigger' }
}
