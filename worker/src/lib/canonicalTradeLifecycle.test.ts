import { buildCanonicalTradeLifecycle } from './canonicalTradeLifecycle'
import type { S12IntradayAssessment } from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const s12Assessment = {
  state: 'reaction_ready',
  setupId: 's12l-2330-test',
  ready: true,
  invalidated: false,
  demandZone1h: { low: 100, high: 102 },
  supplyZone1h: { low: 118, high: 120 },
  execution: { stopLoss: 96, rMultiple: 2.4 },
  defensiveAction: 'none',
  quality: {
    vwap: { state: 'above', priceVsVwapPct: 0.012 },
    vwapContext: {
      schemaVersion: 's12_vwap_context_v1',
      stackState: 'bullish_stack',
      confluenceWidthPct: 0.018,
      session: { value: 103, priceVsPct: 0.01, state: 'above', bars: 8 },
      h1: { value: 102, priceVsPct: 0.02, state: 'above', bars: 2 },
      h4: { value: 101, priceVsPct: 0.03, state: 'above', bars: 1 },
      daily: { value: 100, priceVsPct: 0.04, state: 'above', bars: 1 },
      anchored: {
        day: { value: 103, priceVsPct: 0.01, state: 'above', bars: 8 },
        week: { value: 101, priceVsPct: 0.03, state: 'above', bars: 3 },
        month: { value: 100, priceVsPct: 0.04, state: 'above', bars: 8 },
        quarter: { value: 99, priceVsPct: 0.05, state: 'above', bars: 21 },
        year: { value: 98, priceVsPct: 0.06, state: 'above', bars: 60 },
      },
      nearestAbove: { price: 118, source: 'previous_h1_vwap', distancePct: 0.1 },
      nearestBelow: { price: 102, source: 'h1_vwap', distancePct: 0.01 },
      initialBalance: { high: 106, low: 99, state: 'above', bars: 4 },
      previousZones: { h1: null, h4: null, daily: null },
      previousPeriodZones: {
        day: { value: 100, upper: 102, lower: 98, source: 'previous_day_vwap' },
        week: null,
        month: null,
        quarter: null,
        year: null,
      },
      rolling15m: {
        bars7: { value: 103, priceVsPct: 0.01, state: 'above', bars: 7 },
        bars30: { value: 102, priceVsPct: 0.02, state: 'above', bars: 8 },
        bars90: { value: 102, priceVsPct: 0.02, state: 'above', bars: 8 },
      },
      rollingDays: {
        days7: { value: 101, priceVsPct: 0.03, state: 'above', bars: 3 },
        days30: { value: 100, priceVsPct: 0.04, state: 'above', bars: 8 },
        days90: { value: 99, priceVsPct: 0.05, state: 'above', bars: 21 },
        days365: { value: 98, priceVsPct: 0.06, state: 'above', bars: 60 },
      },
    },
    rvol: { state: 'strong_participation', value: 1.8 },
    notes: [],
  },
  exitPlan: {
    tp1: { price: 108, source: '15m_previous_high' },
    mainExit: { price: 118, source: '1h_supply_zone' },
    tp3: { price: 126, source: '1h_supply_zone_extension' },
    tp4: { price: 134, source: '1h_supply_zone_extension' },
    manualTp: { price: 130, source: 'manual' },
    trailingStop: { initial: 96, method: 'structure_stop_then_15m_higher_low_atr_vwap', source: 'adaptive' },
    reverseWarning: { action: 'none' },
  },
  barDiagnostics: { position_planned_tp: 'tp4' },
  detail: [
    'state=reaction_ready',
    'entry_archetype=equity_repricing_breakout',
    'equity_mutation_context=true',
    'equity_mutation_score=5',
    'equity_mutation_reasons=15m_repricing_breakout|vwap_fast_acceptance|volume_participation',
    'equity_mutation_risk_haircuts=1h_short_risk_haircut',
    'vwap_fast_acceptance=true',
    'vwap_fast_reasons=session_vwap_above|rolling15m_7_above',
    'vwap_slow_context=mixed',
    'htf_hard_block=false',
    'one_h_demand_required=false',
    'one_h_demand_role=evidence_not_hard_gate',
  ].join(';'),
} as unknown as S12IntradayAssessment

const lifecycle = buildCanonicalTradeLifecycle({
  tradeDate: '2026-07-02',
  symbol: '2330',
  marketRiskLevel: 'normal',
  marketRiskScore: 0.2,
  regime: 'bull',
  sizingMode: 's12',
  targetExposure: 0.16,
  allocationAction: 'buy',
  allocationReason: 'test',
  entryPrice: 104,
  stopLoss: 96,
  chaseCeiling: 105,
  s12Assessment,
  s12AssistApplied: true,
  s12ExitPrimary: true,
  initialStop: 96,
  trailingStop: 96,
  tp1: 108,
  tp2: 118,
  atr14: 3,
  stopMultiplier: 2,
  tpMultiplier: 1.5,
  tp2Multiplier: 2,
  atrTp1: 108.5,
  atrTp2: 113,
  mlTp1: 110,
  mlTp2: 116,
  protectiveFloorPolicy: {
    breakEvenActivationPct: 0,
    breakEvenBufferPct: 0,
    tp1TouchProfitLockPct: 0,
    mfeProfitLock3Pct: 0.03,
    mfeProfitLock6Pct: 0.08,
  },
})

assert(lifecycle.owners.entry === 's12_intraday_structure_v1', 'S12-assisted fills must use S12 as entry owner')
assert(lifecycle.owners.exit === 'tw_equity_exit_fusion_v2', 'S12-assisted fills must use Taiwan equity fusion as primary exit owner')
assert(lifecycle.owners.fallbackExit === 'paper_sltp_atr_trailing_v1', 'ATR trailing must remain explicit fallback owner')
assert(lifecycle.entry.s12?.exitPlan.tp3 === 126, 'canonical lifecycle must preserve Pine-style TP3')
assert(lifecycle.entry.s12?.exitPlan.tp4 === 134, 'canonical lifecycle must preserve Pine-style TP4')
assert(lifecycle.entry.s12?.exitPlan.manualTp === 130, 'canonical lifecycle must preserve manual TP')
assert(lifecycle.entry.s12?.exitPlan.plannedTakeProfit === 'tp4', 'canonical lifecycle must preserve planned TP')
assert(lifecycle.exit.fusionPolicy === 'tw_equity_exit_fusion_v2', 'canonical lifecycle must version the exit fusion policy')
assert(lifecycle.exit.anchors.atrTp1 === 108.5 && lifecycle.exit.anchors.mlTp1 === 110, 'canonical lifecycle must preserve ATR and ML runner anchors')
assert(lifecycle.entry.s12?.entryContext.schemaVersion === 's12_equity_mutation_context_v1', 'canonical lifecycle must preserve structured S12 entry context')
assert(lifecycle.entry.s12?.entryContext.entryArchetype === 'equity_repricing_breakout', 'canonical lifecycle must expose S12 entry archetype')
assert(lifecycle.entry.s12?.entryContext.vwapFastAcceptance === true, 'canonical lifecycle must expose fast VWAP acceptance')
assert(lifecycle.entry.s12?.entryContext.vwapSlowContext === 'mixed', 'canonical lifecycle must expose slow VWAP context')
assert(lifecycle.entry.s12?.entryContext.equityMutationRiskHaircuts.includes('1h_short_risk_haircut'), 'canonical lifecycle must preserve S12 risk haircuts')
assert(lifecycle.entry.s12?.entryContext.htfHardBlock === false, 'canonical lifecycle must expose HTF hard-block state')
assert(lifecycle.entry.s12?.quality.vwapContext.schemaVersion === 's12_vwap_context_v1', 'canonical lifecycle must preserve S12 VWAP+ context')
assert(lifecycle.entry.s12?.quality.vwapContext.nearestAbove === 118, 'canonical lifecycle must preserve nearest VWAP+ target')
assert(lifecycle.entry.s12?.quality.vwapContext.anchoredWeek === 101, 'canonical lifecycle must preserve anchored weekly VWAP')
assert(lifecycle.entry.s12?.quality.vwapContext.rolling30d === 100, 'canonical lifecycle must preserve rolling 30D VWAP')
assert(lifecycle.entry.s12?.quality.vwapContext.previousDay === 100, 'canonical lifecycle must preserve previous-day VWAP zone')
assert(lifecycle.exit.fallbackOwner === 'paper_sltp_atr_trailing_v1', 'exit block must expose fallback owner')

const setupOnlyLifecycle = buildCanonicalTradeLifecycle({
  ...{
    tradeDate: '2026-07-08',
    symbol: '1785',
    marketRiskLevel: 'low',
    marketRiskScore: 0.2,
    regime: 'volatile',
    sizingMode: 'risk_parity',
    targetExposure: 0.92,
    allocationAction: 'buy',
    allocationReason: 'allocator_open_slot',
    entryPrice: 141.5,
    stopLoss: 123,
    chaseCeiling: null,
    s12Assessment: { ...s12Assessment, ready: false, state: 'waiting_15m_zone_touch' } as S12IntradayAssessment,
    s12AssistApplied: false,
    s12ExitPrimary: false,
    initialStop: 117.75,
    trailingStop: 117.75,
    tp1: 175.4625,
    tp2: 209.425,
    atr14: 9.5,
    stopMultiplier: 2.5,
    tpMultiplier: 3.575,
    tp2Multiplier: 2,
    atrTp1: 175.4625,
    atrTp2: 209.425,
    mlTp1: 186.43,
    mlTp2: 203.53,
    protectiveFloorPolicy: lifecycle.exit.protectiveFloorPolicy,
  },
})
assert(setupOnlyLifecycle.owners.entry === 'ohlcv_pre_trade_plan_v1', 'setup-only S12 context must not take entry ownership')
assert(setupOnlyLifecycle.owners.exit === 'paper_sltp_atr_trailing_v1', 'setup-only S12 context must keep paper SLTP exit ownership')
assert(setupOnlyLifecycle.exit.initialStop === 117.75, 'setup-only lifecycle must preserve the executable paper SLTP stop')
