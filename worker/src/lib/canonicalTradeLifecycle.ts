import type { S12IntradayAssessment } from './s12IntradayStructure'

export interface CanonicalTradeLifecycle {
  version: 'canonical_trade_lifecycle_v1'
  tradeDate: string
  symbol: string
  owners: {
    context: 'market_regime_alpha_context_v1'
    entry: 's12_intraday_structure_v1' | 'ohlcv_pre_trade_plan_v1'
    exit: 'tw_equity_exit_fusion_v2' | 'paper_sltp_atr_trailing_v1'
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
      engineVersion: string | null
      entryState: string | null
      sessionContextSource: string | null
      calibrationArtifactId: string | null
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
      entryContext: {
        schemaVersion: 's12_equity_mutation_context_v1'
        entryArchetype: string | null
        equityMutationContext: boolean | null
        equityMutationScore: number | null
        equityMutationReasons: string[]
        equityMutationRiskHaircuts: string[]
        vwapFastAcceptance: boolean | null
        vwapFastReasons: string[]
        vwapSlowContext: string | null
        htfHardBlock: boolean | null
        oneHDemandRequired: boolean | null
        oneHDemandRole: string | null
      }
      quality: {
        vwapState: string | null
        priceVsVwapPct: number | null
        vwapContext: {
          schemaVersion: string | null
          stackState: string | null
          confluenceWidthPct: number | null
          session: number | null
          h1: number | null
          h4: number | null
          session60: number | null
          daily: number | null
          anchoredDay: number | null
          anchoredWeek: number | null
          anchoredMonth: number | null
          anchoredQuarter: number | null
          anchoredYear: number | null
          rolling7d: number | null
          rolling30d: number | null
          rolling90d: number | null
          rolling365d: number | null
          previousDay: number | null
          previousWeek: number | null
          previousMonth: number | null
          nearestAbove: number | null
          nearestAboveSource: string | null
          nearestBelow: number | null
          nearestBelowSource: string | null
          initialBalanceHigh: number | null
          initialBalanceLow: number | null
          initialBalanceState: string | null
        }
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
    tp1Source: 'tw_equity_runner_fusion_v2' | 'sltp_atr_default'
    tp2Source: 'tw_equity_runner_fusion_v2' | 'sltp_atr_default'
    fusionPolicy: 'tw_equity_exit_fusion_v2' | null
    anchors: {
      atrTp1: number | null
      atrTp2: number | null
      mlTp1: number | null
      mlTp2: number | null
    }
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

function detailPairs(detail: unknown): Record<string, string> {
  const text = String(detail ?? '').trim()
  if (!text) return {}
  const out: Record<string, string> = {}
  for (const part of text.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function boolFromDetail(value: unknown): boolean | null {
  const text = String(value ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(text)) return true
  if (['false', '0', 'no', 'n'].includes(text)) return false
  return null
}

function listFromDetail(value: unknown): string[] {
  const text = String(value ?? '').trim()
  if (!text) return []
  return text.split('|').map((item) => item.trim()).filter(Boolean)
}

function buildS12EntryContext(s12: S12IntradayAssessment): CanonicalTradeLifecycle['entry']['s12'] extends infer T
  ? T extends { entryContext: infer C } ? C : never
  : never {
  const parts = detailPairs(s12.detail)
  return {
    schemaVersion: 's12_equity_mutation_context_v1',
    entryArchetype: parts.entry_archetype ?? null,
    equityMutationContext: boolFromDetail(parts.equity_mutation_context),
    equityMutationScore: finiteNumber(parts.equity_mutation_score),
    equityMutationReasons: listFromDetail(parts.equity_mutation_reasons),
    equityMutationRiskHaircuts: listFromDetail(parts.equity_mutation_risk_haircuts),
    vwapFastAcceptance: boolFromDetail(parts.vwap_fast_acceptance),
    vwapFastReasons: listFromDetail(parts.vwap_fast_reasons),
    vwapSlowContext: parts.vwap_slow_context ?? null,
    htfHardBlock: boolFromDetail(parts.htf_hard_block),
    oneHDemandRequired: boolFromDetail(parts.one_h_demand_required),
    oneHDemandRole: parts.one_h_demand_role ?? null,
  }
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
  atrTp1?: number | null
  atrTp2?: number | null
  mlTp1?: number | null
  mlTp2?: number | null
  protectiveFloorPolicy: CanonicalTradeLifecycle['exit']['protectiveFloorPolicy']
}): CanonicalTradeLifecycle {
  const s12 = input.s12Assessment
  const s12VwapContext = s12?.quality?.vwapContext
  const exitOwner = input.s12ExitPrimary ? 'tw_equity_exit_fusion_v2' : 'paper_sltp_atr_trailing_v1'
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
          engineVersion: s12.engineVersion ?? null,
          entryState: s12.entryState ?? null,
          sessionContextSource: s12.sessionContextSource ?? null,
          calibrationArtifactId: String(s12.barDiagnostics?.calibration_artifact_id ?? '').trim() || null,
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
          entryContext: buildS12EntryContext(s12),
          quality: {
            vwapState: s12.quality.vwap.state,
            priceVsVwapPct: finiteNumber(s12.quality.vwap.priceVsVwapPct),
            vwapContext: {
              schemaVersion: s12VwapContext?.schemaVersion ?? null,
              stackState: s12VwapContext?.stackState ?? null,
              confluenceWidthPct: finiteNumber(s12VwapContext?.confluenceWidthPct),
              session: positiveNumber(s12VwapContext?.session?.value),
              h1: positiveNumber(s12VwapContext?.h1?.value),
              h4: positiveNumber(s12VwapContext?.h4?.value),
              session60: positiveNumber(s12VwapContext?.session60?.value),
              daily: positiveNumber(s12VwapContext?.daily?.value),
              anchoredDay: positiveNumber(s12VwapContext?.anchored?.day?.value),
              anchoredWeek: positiveNumber(s12VwapContext?.anchored?.week?.value),
              anchoredMonth: positiveNumber(s12VwapContext?.anchored?.month?.value),
              anchoredQuarter: positiveNumber(s12VwapContext?.anchored?.quarter?.value),
              anchoredYear: positiveNumber(s12VwapContext?.anchored?.year?.value),
              rolling7d: positiveNumber(s12VwapContext?.rollingDays?.days7?.value),
              rolling30d: positiveNumber(s12VwapContext?.rollingDays?.days30?.value),
              rolling90d: positiveNumber(s12VwapContext?.rollingDays?.days90?.value),
              rolling365d: positiveNumber(s12VwapContext?.rollingDays?.days365?.value),
              previousDay: positiveNumber(s12VwapContext?.previousPeriodZones?.day?.value),
              previousWeek: positiveNumber(s12VwapContext?.previousPeriodZones?.week?.value),
              previousMonth: positiveNumber(s12VwapContext?.previousPeriodZones?.month?.value),
              nearestAbove: positiveNumber(s12VwapContext?.nearestAbove?.price),
              nearestAboveSource: s12VwapContext?.nearestAbove?.source ?? null,
              nearestBelow: positiveNumber(s12VwapContext?.nearestBelow?.price),
              nearestBelowSource: s12VwapContext?.nearestBelow?.source ?? null,
              initialBalanceHigh: positiveNumber(s12VwapContext?.initialBalance?.high),
              initialBalanceLow: positiveNumber(s12VwapContext?.initialBalance?.low),
              initialBalanceState: s12VwapContext?.initialBalance?.state ?? null,
            },
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
      tp1Source: input.s12ExitPrimary ? 'tw_equity_runner_fusion_v2' : 'sltp_atr_default',
      tp2Source: input.s12ExitPrimary ? 'tw_equity_runner_fusion_v2' : 'sltp_atr_default',
      fusionPolicy: input.s12ExitPrimary ? 'tw_equity_exit_fusion_v2' : null,
      anchors: {
        atrTp1: positiveNumber(input.atrTp1),
        atrTp2: positiveNumber(input.atrTp2),
        mlTp1: positiveNumber(input.mlTp1),
        mlTp2: positiveNumber(input.mlTp2),
      },
      protectiveFloorPolicy: input.protectiveFloorPolicy,
      fallbackOwner: 'paper_sltp_atr_trailing_v1',
    },
  }
}

export function serializeCanonicalTradeLifecycle(lifecycle: CanonicalTradeLifecycle): string {
  return JSON.stringify(lifecycle)
}
