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
  detail: 'state=reaction_ready',
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
  protectiveFloorPolicy: {
    breakEvenActivationPct: 0,
    breakEvenBufferPct: 0,
    tp1TouchProfitLockPct: 0,
    mfeProfitLock3Pct: 0.03,
    mfeProfitLock6Pct: 0.08,
  },
})

assert(lifecycle.owners.entry === 's12_intraday_structure_v1', 'S12-assisted fills must use S12 as entry owner')
assert(lifecycle.owners.exit === 's12_position_decision_v1', 'S12-assisted fills must use S12 as primary exit owner')
assert(lifecycle.owners.fallbackExit === 'paper_sltp_atr_trailing_v1', 'ATR trailing must remain explicit fallback owner')
assert(lifecycle.entry.s12?.exitPlan.tp3 === 126, 'canonical lifecycle must preserve Pine-style TP3')
assert(lifecycle.entry.s12?.exitPlan.tp4 === 134, 'canonical lifecycle must preserve Pine-style TP4')
assert(lifecycle.entry.s12?.exitPlan.manualTp === 130, 'canonical lifecycle must preserve manual TP')
assert(lifecycle.entry.s12?.exitPlan.plannedTakeProfit === 'tp4', 'canonical lifecycle must preserve planned TP')
assert(lifecycle.entry.s12?.quality.vwapContext.schemaVersion === 's12_vwap_context_v1', 'canonical lifecycle must preserve S12 VWAP+ context')
assert(lifecycle.entry.s12?.quality.vwapContext.nearestAbove === 118, 'canonical lifecycle must preserve nearest VWAP+ target')
assert(lifecycle.entry.s12?.quality.vwapContext.anchoredWeek === 101, 'canonical lifecycle must preserve anchored weekly VWAP')
assert(lifecycle.entry.s12?.quality.vwapContext.rolling30d === 100, 'canonical lifecycle must preserve rolling 30D VWAP')
assert(lifecycle.entry.s12?.quality.vwapContext.previousDay === 100, 'canonical lifecycle must preserve previous-day VWAP zone')
assert(lifecycle.exit.fallbackOwner === 'paper_sltp_atr_trailing_v1', 'exit block must expose fallback owner')
