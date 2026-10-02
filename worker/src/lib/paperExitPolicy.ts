import { readSwingState } from './paperSwingLifecycle'
import { assessSwingExit } from './paperSwingPolicy'
import { paperExecutionNow } from './paperExecutionScope'
import type { MarketRegime } from './dynamicExitPriority'
import type { TradingConfig } from './tradingConfig'
import { normalizeTwEquityStopPrice, normalizeTwEquityTargetPrice } from './twEquityMarketContract'

export interface ExitPosition {
  trade_lifecycle_json?: unknown
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
  exitIntentKind?: 'risk_stop' | 'take_profit' | 'model_exit' | 'time_stop' | 'forced_close'
  sellShares?: number
  newTrailingStop?: number
  newHighest?: number
  newTp2Price?: number
  moveStopToEntry?: boolean
  tradeLifecycleJson?: string | null
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
  const swing=readSwingState(pos.trade_lifecycle_json)
  if(swing) {
    const nowMs=paperExecutionNow(), date=new Date(nowMs+8*3600_000).toISOString().slice(0,10)
    if(currentPrice<=swing.entryPrice*.92 || (swing.pendingExit && nowMs>=swing.pendingExit.notBeforeMs))
      return assessSwingExit(swing,{date,nowMs,price:currentPrice,calendar:[]})
    return {action:'hold',reason:'swing_hold_requires_daily_evidence'}
  }
  const ex = cfg.exit
  void resolvedSltp
  void atr14
  const entryPrice = pos.entry_price ?? pos.avg_cost
  const pnlPct = (currentPrice - entryPrice) / entryPrice

  // Fixed initial risk; only a completed TP1 fill may move protection to entry.
  // Existing tighter stops remain protected during migration.
  void regime
  void ex.dynamicExitPriorityEnabled

  const effHardStopPct = ex.hardStopPct
  if (pnlPct <= effHardStopPct) {
    return {
      action: 'full_sell',
      reason: `Hard stop ${(pnlPct * 100).toFixed(1)}%`,
      exitIntentKind: 'risk_stop',
    }
  }

  const initStopRaw = normalizeTwEquityStopPrice(pos.initial_stop ?? entryPrice * ex.fallbackInitStopMult)
  const effInitStop = initStopRaw
  if (currentPrice <= effInitStop) {
    return {
      action: 'full_sell',
      reason: `InitStop 初始停損 @ ${effInitStop.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%`,
      exitIntentKind: 'risk_stop',
    }
  }

  if (isEOD && hasMlSell) {
    return { action: 'full_sell', reason: 'ML SELL', exitIntentKind: 'model_exit' }
  }

  const trailingStopRaw = Math.max(pos.trailing_stop ?? initStopRaw, pos.tp1_hit ? entryPrice : initStopRaw)
  const effTrailingStop = trailingStopRaw
  if (currentPrice <= effTrailingStop && effTrailingStop > effInitStop) {
    return {
      action: 'full_sell',
      reason: `Trailing Stop @ ${effTrailingStop.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%`,
      exitIntentKind: 'risk_stop',
    }
  }

  const initStop = initStopRaw
  void trailingStopRaw

  const tp1 = normalizeTwEquityTargetPrice(pos.tp1_price ?? entryPrice * ex.fallbackTp1Mult)
  if (currentPrice >= tp1 && !pos.tp1_hit) {
    const sellShares = Math.floor(((pos.original_shares ?? pos.shares) * ex.tp1SellRatio) / 1000) * 1000
    if (sellShares > 0 && sellShares < pos.shares) {
      return {
        action: 'partial_sell',
        reason: `TP1 take profit @ ${currentPrice.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%`,
        exitIntentKind: 'take_profit',
        sellShares,
        moveStopToEntry: true,
      }
    }

    return { action: 'full_sell', reason: `TP1 full exit @ ${currentPrice.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%`, exitIntentKind: 'take_profit' }
  }

  const highestSoFar = Math.max(pos.highest_since_entry ?? entryPrice, currentPrice)
  const tp2 = normalizeTwEquityTargetPrice(pos.tp2_price ?? entryPrice * ex.fallbackTp2Mult)
  const previousHighest = pos.highest_since_entry ?? entryPrice

  if (currentPrice >= tp2 && pos.tp1_hit) {
    return { action: 'full_sell', reason: `TP2 take profit @ ${currentPrice.toFixed(1)} ${(pnlPct * 100).toFixed(1)}%`, exitIntentKind: 'take_profit' }
  }

  if (isEOD && pos.entry_date) {
    const daysSinceEntry = Math.floor((paperExecutionNow() - new Date(pos.entry_date).getTime()) / 86400000)
    if (daysSinceEntry > ex.timeStopDays && pnlPct > ex.timeStopMinProfit) {
      return { action: 'full_sell', reason: `Time stop ${daysSinceEntry}d +${(pnlPct * 100).toFixed(1)}%`, exitIntentKind: 'time_stop' }
    }
  }

  const prevTrailing = pos.trailing_stop ?? initStop
  const updatedTrailing = normalizeTwEquityStopPrice(Math.max(prevTrailing, pos.tp1_hit ? entryPrice : initStop))

  if (updatedTrailing !== prevTrailing || highestSoFar !== previousHighest) {
    return {
      action: 'hold',
      reason: 'fixed stop / high-water mark update',
      newTrailingStop: updatedTrailing,
      newHighest: highestSoFar,
    }
  }

  return { action: 'hold', reason: 'no trigger' }
}
