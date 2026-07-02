import type { S12IntradayAssessment } from './s12IntradayStructure'

export interface CanonicalTradeLifecycle {
  version: 'canonical_trade_lifecycle_v1'
  tradeDate: string
  symbol: string
  owners: {
    context: 'market_regime_alpha_context_v1'
    entry: 's12_intraday_structure_v1' | 'ohlcv_pre_trade_plan_v1'
    exit: 's12_position_decision_v1' | 'paper_sltp_atr_trailing_v1'
    fallbackExit: 'paper_sltp_atr_trailing_v1'
  }
  context: {
    marketRiskLevel: string | null
    marketRiskScore: number | null
    regime: string | null
    sizingMode: string | null
    targetExposure: number | null
    allocationAction: string | null
    allocationReason: string | null
  }
  entry: {
    entryPrice: number
    stopLoss: number | null
    chaseCeiling: number | null
    source: 's12_assist_entry' | 'pre_trade_plan'
    s12: {
      state: string | null
      setupId: string | null
      ready: boolean
      invalidated: boolean
      demandZoneLow: number | null
      demandZoneHigh: number | null
      supplyZoneLow: number | null
      supplyZoneHigh: number | null
      structureStop: number | null
      rMultiple: number | null
      defensiveAction: string | null
      quality: {
        vwapState: string | null
        priceVsVwapPct: number | null
        rvolState: string | null
        rvol: number | null
        notes: string[]
      }
      exitPlan: {
        tp1: number | null
        tp1Source: string | null
        mainExit: number | null
        mainExitSource: string | null
        tp3: number | null
        tp3Source: string | null
        tp4: number | null
        tp4Source: string | null
        manualTp: number | null
        manualTpSource: string | null
        plannedTakeProfit: string | null
        trailingInitial: number | null
        trailingMethod: string | null
        trailingSource: string | null
        reverseWarningAction: string | null
      }
      detail: string | null
    } | null
  }
  exit: {
    initialStop: number
    trailingStop: number
    tp1: number
    tp2: number
    atr14: number
    stopMultiplier: number
    tpMultiplier: number
    tp2Multiplier: number
    protectiveFloorPolicy: {
      breakEvenActivationPct: number
      breakEvenBufferPct: number
      tp1TouchProfitLockPct: number
      mfeProfitLock3Pct: number
      mfeProfitLock6Pct: number
    }
    fallbackOwner: 'paper_sltp_atr_trailing_v1'
  }
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function positiveNumber(value: unknown): number | null {
  const n = finiteNumber(value)
  return n != null && n > 0 ? n : null
}

export function buildCanonicalTradeLifecycle(input: {
  tradeDate: string
  symbol: string
  marketRiskLevel: string | null
  marketRiskScore: number | null
  regime: string | null
  sizingMode: string | null
  targetExposure: number | null
  allocationAction: string | null
  allocationReason: string | null
  entryPrice: number
  stopLoss: number | null
  chaseCeiling: number | null
  s12Assessment: S12IntradayAssessment | null
  s12AssistApplied: boolean
  s12ExitPrimary: boolean
  initialStop: number
  trailingStop: number
  tp1: number
  tp2: number
  atr14: number
  stopMultiplier: number
  tpMultiplier: number
  tp2Multiplier: number
  protectiveFloorPolicy: CanonicalTradeLifecycle['exit']['protectiveFloorPolicy']
}): CanonicalTradeLifecycle {
  const s12 = input.s12Assessment
  const exitOwner = input.s12ExitPrimary ? 's12_position_decision_v1' : 'paper_sltp_atr_trailing_v1'
  return {
    version: 'canonical_trade_lifecycle_v1',
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    owners: {
      context: 'market_regime_alpha_context_v1',
      entry: input.s12AssistApplied ? 's12_intraday_structure_v1' : 'ohlcv_pre_trade_plan_v1',
      exit: exitOwner,
      fallbackExit: 'paper_sltp_atr_trailing_v1',
    },
    context: {
      marketRiskLevel: input.marketRiskLevel,
      marketRiskScore: input.marketRiskScore,
      regime: input.regime,
      sizingMode: input.sizingMode,
      targetExposure: finiteNumber(input.targetExposure),
      allocationAction: input.allocationAction,
      allocationReason: input.allocationReason,
    },
    entry: {
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      chaseCeiling: input.chaseCeiling,
      source: input.s12AssistApplied ? 's12_assist_entry' : 'pre_trade_plan',
      s12: s12
        ? {
          state: s12.state,
          setupId: s12.setupId ?? null,
          ready: s12.ready,
          invalidated: s12.invalidated,
          demandZoneLow: positiveNumber(s12.demandZone1h?.low),
          demandZoneHigh: positiveNumber(s12.demandZone1h?.high),
          supplyZoneLow: positiveNumber(s12.supplyZone1h?.low),
          supplyZoneHigh: positiveNumber(s12.supplyZone1h?.high),
          structureStop: positiveNumber(s12.execution.stopLoss),
          rMultiple: finiteNumber(s12.execution.rMultiple),
          defensiveAction: s12.defensiveAction === 'none' ? null : s12.defensiveAction,
          quality: {
            vwapState: s12.quality.vwap.state,
            priceVsVwapPct: finiteNumber(s12.quality.vwap.priceVsVwapPct),
            rvolState: s12.quality.rvol.state,
            rvol: finiteNumber(s12.quality.rvol.value),
            notes: s12.quality.notes,
          },
          exitPlan: {
            tp1: positiveNumber(s12.exitPlan.tp1.price),
            tp1Source: s12.exitPlan.tp1.source === 'unavailable' ? null : s12.exitPlan.tp1.source,
            mainExit: positiveNumber(s12.exitPlan.mainExit.price),
            mainExitSource: s12.exitPlan.mainExit.source === 'unavailable' ? null : s12.exitPlan.mainExit.source,
            tp3: positiveNumber(s12.exitPlan.tp3.price),
            tp3Source: s12.exitPlan.tp3.source === 'unavailable' ? null : s12.exitPlan.tp3.source,
            tp4: positiveNumber(s12.exitPlan.tp4.price),
            tp4Source: s12.exitPlan.tp4.source === 'unavailable' ? null : s12.exitPlan.tp4.source,
            manualTp: positiveNumber(s12.exitPlan.manualTp.price),
            manualTpSource: s12.exitPlan.manualTp.source === 'unavailable' ? null : s12.exitPlan.manualTp.source,
            plannedTakeProfit: String(s12.barDiagnostics?.position_planned_tp ?? '').trim() || null,
            trailingInitial: positiveNumber(s12.exitPlan.trailingStop.initial),
            trailingMethod: s12.exitPlan.trailingStop.method,
            trailingSource: s12.exitPlan.trailingStop.source,
            reverseWarningAction: s12.exitPlan.reverseWarning.action === 'none' ? null : s12.exitPlan.reverseWarning.action,
          },
          detail: s12.detail ?? null,
        }
        : null,
    },
    exit: {
      initialStop: input.initialStop,
      trailingStop: input.trailingStop,
      tp1: input.tp1,
      tp2: input.tp2,
      atr14: input.atr14,
      stopMultiplier: input.stopMultiplier,
      tpMultiplier: input.tpMultiplier,
      tp2Multiplier: input.tp2Multiplier,
      protectiveFloorPolicy: input.protectiveFloorPolicy,
      fallbackOwner: 'paper_sltp_atr_trailing_v1',
    },
  }
}

export function serializeCanonicalTradeLifecycle(lifecycle: CanonicalTradeLifecycle): string {
  return JSON.stringify(lifecycle)
}
