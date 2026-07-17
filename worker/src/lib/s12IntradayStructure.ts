import {
  normalizeTwEquityStopPrice,
  normalizeTwEquityTargetPrice,
  resolveTwEquityPriceBand,
} from './twEquityMarketContract'

export interface S12Bar {
  startMs: number
  open: number
  high: number
  low: number
  close: number
  volume?: number | null
}

export type S12IntradayState =
  | 'waiting_15m_completed_bars'
  | 'waiting_session_60m_completed_bar'
  /** @deprecated Historical snapshot compatibility. Runtime no longer requires a long session bias. */
  | 'waiting_session_60m_long_bias'
  | 'waiting_session_60m_bearish_risk'
  | 'waiting_4h_completed_bar'
  | 'waiting_4h_long_bias'
  | 'waiting_1h_completed_bar'
  | 'waiting_1h_demand_zone'
  | 'waiting_15m_zone_touch'
  | 'waiting_sweep'
  | 'waiting_choch'
  | 'waiting_bos'
  | 'waiting_retest'
  | 'waiting_reaction'
  | 'limited_takeover_ready'
  | 'reaction_ready'
  | 'bearish_defense_ready'
  | 'invalidated'

export type S12IntradayZoneType =
  | 'bullish_order_block'
  | 'bearish_order_block'
  | 'bullish_fvg'
  | 'bearish_fvg'
  | 'support'
  | 'resistance'
  | 'order_block'
  | 'pivot_demand'
  | 'pivot_supply'

export type S12DefensiveAction =
  | 'none'
  | 'NO_BUY'
  | 'WAIT_RESET'
  | 'LOWER_CONFIDENCE'
  | 'TIGHTEN_STOP'
  | 'TRIM'
  | 'TAKE_PROFIT'
  | 'EXIT_ON_REVERSE_BOS'

export type S12PositionStopSource =
  | 'adaptive'
  | '15m_protected_low'
  | '15m_recent_fvg'
  | '15m_order_block'

export type S12PlannedTakeProfit = 'tp2' | 'tp3' | 'tp4'

export interface S12IntradayZone {
  type: S12IntradayZoneType
  low: number
  high: number
  createdMs: number
  ageBars: number
}

export interface S12HtfBias {
  direction: 'long' | 'neutral' | 'short'
  confidence: 'none' | 'provisional' | 'confirmed'
  channelAlign: boolean
}

export interface S12BearishDefense {
  state:
    | 'no_supply_zone'
    | 'waiting_supply_zone_touch'
    | 'waiting_bsl_sweep'
    | 'waiting_choch_down'
    | 'waiting_bos_down'
    | 'waiting_bearish_retest'
    | 'bearish_defense_ready'
  ready: boolean
  action: S12DefensiveAction
  reason: string
  detail: string
  supplyZone1h: S12IntradayZone | null
  sequence: {
    zoneTouchMs?: number | null
    sweepMs?: number | null
    chochMs?: number | null
    bosMs?: number | null
    retestMs?: number | null
    reactionMs?: number | null
  }
}

export interface S12StructureQuality {
  vwap: {
    value: number | null
    priceVsVwapPct: number | null
    state: 'above' | 'below' | 'flat' | 'unavailable'
  }
  vwapContext: {
    schemaVersion: 's12_vwap_context_v1'
    session: S12VwapMetric
    session60: S12VwapMetric
    h1: S12VwapMetric
    h4: S12VwapMetric
    daily: S12VwapMetric
    anchored: {
      day: S12VwapMetric
      week: S12VwapMetric
      month: S12VwapMetric
      quarter: S12VwapMetric
      year: S12VwapMetric
    }
    rolling15m: {
      bars7: S12VwapMetric
      bars30: S12VwapMetric
      bars90: S12VwapMetric
    }
    rollingDays: {
      days7: S12VwapMetric
      days30: S12VwapMetric
      days90: S12VwapMetric
      days365: S12VwapMetric
    }
    previousZones: {
      h1: S12VwapZone | null
      h4: S12VwapZone | null
      daily: S12VwapZone | null
    }
    previousPeriodZones: {
      day: S12VwapZone | null
      week: S12VwapZone | null
      month: S12VwapZone | null
      quarter: S12VwapZone | null
      year: S12VwapZone | null
    }
    initialBalance: {
      high: number | null
      low: number | null
      state: 'above' | 'below' | 'inside' | 'unavailable'
      bars: number
    }
    stackState: 'bullish_stack' | 'bearish_stack' | 'mixed' | 'unavailable'
    confluenceWidthPct: number | null
    nearestAbove: S12VwapTarget | null
    nearestBelow: S12VwapTarget | null
  }
  rvol: {
    value: number | null
    state: 'strong_participation' | 'participating' | 'thin' | 'unavailable'
    lookbackBars: number
  }
  notes: string[]
}

export interface S12VwapMetric {
  value: number | null
  priceVsPct: number | null
  state: 'above' | 'below' | 'flat' | 'unavailable'
  bars: number
}

export interface S12VwapZone {
  value: number | null
  upper: number | null
  lower: number | null
  source:
    | 'previous_h1_vwap'
    | 'previous_h4_vwap'
    | 'previous_daily_vwap'
    | 'previous_day_vwap'
    | 'previous_week_vwap'
    | 'previous_month_vwap'
    | 'previous_quarter_vwap'
    | 'previous_year_vwap'
}

export interface S12VwapTarget {
  price: number
  source:
    | S12VwapZone['source']
    | 'session_vwap'
    | 'h1_vwap'
    | 'h4_vwap'
    | 'daily_vwap'
    | 'anchored_day_vwap'
    | 'anchored_week_vwap'
    | 'anchored_month_vwap'
    | 'anchored_quarter_vwap'
    | 'anchored_year_vwap'
    | 'rolling15m_7'
    | 'rolling15m_30'
    | 'rolling15m_90'
    | 'rolling7d_vwap'
    | 'rolling30d_vwap'
    | 'rolling90d_vwap'
    | 'rolling365d_vwap'
  distancePct: number
}

export interface S12StructureExitPlan {
  mode: 'structure_first_trailing_v1'
  tp1: {
    price: number | null
    source: '15m_previous_high' | 'vwap_fair_value' | 'r_multiple_fallback' | 'unavailable'
    action: 'partial_take_profit'
  }
  mainExit: {
    price: number | null
    zoneLow: number | null
    zoneHigh: number | null
    source: '1h_supply_zone' | 'vwap_fair_value' | 'tp_ladder' | 'r_multiple_fallback' | 'unavailable'
    action: 'main_take_profit'
  }
  tp3: {
    price: number | null
    source: '1h_supply_zone' | 'vwap_fair_value' | 'tp_ladder' | 'r_multiple_fallback' | 'unavailable'
    action: 'extended_take_profit'
  }
  tp4: {
    price: number | null
    source: '1h_supply_zone' | 'vwap_fair_value' | 'tp_ladder' | 'r_multiple_fallback' | 'unavailable'
    action: 'extended_take_profit'
  }
  manualTp: {
    price: number | null
    source: 'unavailable'
    action: 'manual_take_profit'
  }
  trailingStop: {
    initial: number | null
    method:
      | 'structure_stop_then_15m_higher_low_atr_vwap'
      | '15m_protected_low'
      | '15m_recent_bullish_fvg'
      | '15m_bullish_order_block'
    source: S12PositionStopSource
    activation: 'after_tp1_or_reverse_choch'
  }
  reverseWarning: {
    state: S12BearishDefense['state'] | null
    action: S12DefensiveAction
    source: 'bearish_defense_sidecar'
  }
}

interface S12EquityMutationContext {
  active: boolean
  archetype: 'equity_repricing_breakout' | 'equity_limited_takeover' | 'unavailable'
  score: number
  reasons: string[]
  riskHaircuts: string[]
  vwapFastAcceptance: boolean
  vwapFastReasons: string[]
  vwapFastBlockers: string[]
  vwapSlowContext: string
  htfHardBlock: boolean
  strictBreakout: boolean
  limitedTakeover: boolean
  sizeMultiplier: number | null
  stopRiskPct: number | null
  stopRiskAtr: number | null
  zone: S12IntradayZone | null
  stopPlan: S12PositionStopPlan | null
  entryPrice: number | null
  chaseCeiling: number | null
  atr15m: number | null
}

export type S12H4Source = 'current_session' | 'previous_trading_day_fallback' | 'unavailable'

export type S12RuntimeBarDiagnostics = Record<string, unknown>

export interface S12TimingPolicy {
  min15mBars: number
  seededFastMaturityEnabled: boolean
  seededMin15mBars: number
  atr15mBars: number
  zoneAtrBars: number
  rvolLookbackBars: number
  swingLookbackBars: number
  srPivotLen: number
  srAtrLen: number
  srZoneAtr: number
  srMergeDistanceAtr: number
  srBreakBufferAtr: number
  srBreakConfirmBars: number
  obLookbackBars: number
  minFvgAtr: number
  maxVisibleZones: number
  positionStopSource: S12PositionStopSource
  plannedTakeProfit: S12PlannedTakeProfit
  manualTakeProfitPrice: number | null
  coachMaxWaitBars: number
  triggerMode: 'touch' | 'reaction_close'
  priorDirectionalBars: number
  zoneTouchStaleBars: number
  sweepWaitBars: number
  chochWaitBars: number
  bosWaitBars: number
  retestWaitBars: number
  fullCoverage15mBars: number
  fullCoverage1hBars: number
  fullCoverageSession60Bars: number
  minFastVwapSignals: number
  maxFastVwapBlockers: number
  slowVwapSupportiveRatio: number
  slowVwapOverheadRatio: number
  volumeExpansionMin: number
  repricingBreakoutAtr: number
  sessionAcceptanceMinMoveAtr: number
  sessionAcceptanceMinClosePosition: number
  sessionLockToleranceAtr: number
  sessionLockTolerancePct: number
  sessionLockMinBars: number
  strongClosePosition: number
  strongBodyPct: number
  higherLowAtrTolerance: number
  maxStopRiskPct: number
  maxStopRiskAtr: number
  strictMutationMinScore: number
  limitedMutationMinScore: number
  strictSizeMultiplier: number
  limitedSizeMultiplier: number
  chaseAtrMultiplier: number
  stopStructureBufferAtr: number
  /** @deprecated Compatibility only. V2 uses fullCoverageSession60Bars. */
  fullCoverage4hBars: number
}

export const DEFAULT_S12_TIMING_POLICY: S12TimingPolicy = {
  min15mBars: 4,
  seededFastMaturityEnabled: true,
  seededMin15mBars: 3,
  atr15mBars: 14,
  zoneAtrBars: 8,
  rvolLookbackBars: 20,
  swingLookbackBars: 5,
  srPivotLen: 8,
  srAtrLen: 14,
  srZoneAtr: 0.2,
  srMergeDistanceAtr: 1.25,
  srBreakBufferAtr: 0.15,
  srBreakConfirmBars: 2,
  obLookbackBars: 20,
  minFvgAtr: 0.05,
  maxVisibleZones: 3,
  positionStopSource: '15m_protected_low',
  plannedTakeProfit: 'tp2',
  manualTakeProfitPrice: null,
  coachMaxWaitBars: 120,
  triggerMode: 'touch',
  priorDirectionalBars: 3,
  zoneTouchStaleBars: 16,
  sweepWaitBars: 16,
  chochWaitBars: 12,
  bosWaitBars: 24,
  retestWaitBars: 16,
  fullCoverage15mBars: 12,
  fullCoverage1hBars: 3,
  fullCoverageSession60Bars: 3,
  minFastVwapSignals: 2,
  maxFastVwapBlockers: 1,
  slowVwapSupportiveRatio: 0.6,
  slowVwapOverheadRatio: 0.25,
  volumeExpansionMin: 1.25,
  repricingBreakoutAtr: 0.05,
  sessionAcceptanceMinMoveAtr: 0.35,
  sessionAcceptanceMinClosePosition: 0.75,
  sessionLockToleranceAtr: 0.03,
  sessionLockTolerancePct: 0.0005,
  sessionLockMinBars: 2,
  strongClosePosition: 0.62,
  strongBodyPct: 0.22,
  higherLowAtrTolerance: 0.15,
  maxStopRiskPct: 0.045,
  maxStopRiskAtr: 3.2,
  strictMutationMinScore: 5,
  limitedMutationMinScore: 4,
  strictSizeMultiplier: 0.65,
  limitedSizeMultiplier: 0.4,
  chaseAtrMultiplier: 0.25,
  stopStructureBufferAtr: 0.1,
  fullCoverage4hBars: 3,
}

export interface S12IntradayAssessment {
  version: 's12_intraday_structure_v1'
  engineVersion?: 's12_smcvwap_tw_equity_v2'
  symbol: string
  direction: 'long'
  state: S12IntradayState
  entryState?: 'OBSERVE' | 'CONTEXT_ELIGIBLE' | 'REPRICING_OR_REVERSAL' | 'RETEST_ACCEPTED' | 'EXECUTABLE' | 'INVALIDATED'
  ready: boolean
  invalidated: boolean
  reason: string
  detail: string
  setupId: string | null
  completedBars: {
    m15: number
    h1: number
    session60?: number
    /** @deprecated Compatibility mirror of session60. */
    h4: number
  }
  sessionContextSource?: 'current_session_60m' | 'previous_session_60m' | 'unavailable'
  h4Source: S12H4Source
  h4ReferenceDate: string | null
  h4ReferenceClose: number | null
  barDiagnostics: S12RuntimeBarDiagnostics
  coverage: 'none' | 'partial' | 'full'
  bias4h: S12HtfBias
  biasSession60?: S12HtfBias
  bias1h: S12HtfBias
  demandZone1h: S12IntradayZone | null
  supplyZone1h: S12IntradayZone | null
  bearishDefense: S12BearishDefense
  defensiveAction: S12DefensiveAction
  quality: S12StructureQuality
  exitPlan: S12StructureExitPlan
  sequence: {
    zoneTouchMs?: number | null
    sweepMs?: number | null
    chochMs?: number | null
    bosMs?: number | null
    retestMs?: number | null
    reactionMs?: number | null
  }
  execution: {
    entryPrice?: number | null
    chaseCeiling?: number | null
    stopLoss?: number | null
    target1?: number | null
    target2?: number | null
    target3?: number | null
    target4?: number | null
    atr15m?: number | null
    rMultiple?: number | null
  }
  maturity: {
    takeoverEligible: boolean
    takeoverRole: 'none' | 'long_entry' | 'no_buy_defense' | 'invalidate'
    tier:
      | 'none'
      | 'limited_takeover_ready'
      | 'full_reaction_ready'
      | 'defensive_invalidation'
      | 'no_buy_defense'
    riskMode:
      | 'none'
      | 'reduced_size_tight_stop'
      | 'normal_size_structure_stop'
      | 'full_size_reaction'
      | 'defense_only'
    policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated'
    blocker: S12IntradayState
    stage: 'data' | 'higher_timeframe_bias' | 'setup' | 'trigger_sequence' | 'ready' | 'defensive' | 'invalidated'
    stale?: boolean
    staleReason?: string | null
    staleAfterBars?: number | null
    elapsedBars?: number | null
  }
}

export type S12UnifiedDecisionAction =
  | 'WAIT'
  | 'READY'
  | 'DEFER'
  | 'NO_BUY'
  | 'INVALIDATED'
  | 'QUOTE_UNAVAILABLE'
  | 'TAKE_PROFIT'
  | 'TIGHTEN_STOP'
  | 'SET_STRUCTURAL_STOP'
  | 'EXIT_ON_REVERSE_BOS'

export interface S12UnifiedDecision {
  action: S12UnifiedDecisionAction
  reason: string
  detail: string
  stage: S12IntradayAssessment['maturity']['stage']
  role: S12IntradayAssessment['maturity']['takeoverRole'] | 'position_exit' | 'position_defense'
  source: 's12_intraday_structure_v1' | 's12_position_decision_v1'
  executableBookRequired: boolean
  noShortOrder: true
  s12State: S12IntradayState | null
  setupId: string | null
  targetPrice?: number | null
  stopPrice?: number | null
  sellShares?: number | null
  sellRatio?: number | null
}

export interface S12PositionDecisionInput {
  assessment: S12IntradayAssessment | null
  currentPrice: number
  executableBookAvailable: boolean
  atr14?: number | null
  tp1SellRatio?: number | null
  pos: {
    shares?: number | null
    original_shares?: number | null
    avg_cost?: number | null
    entry_price?: number | null
    initial_stop?: number | null
    trailing_stop?: number | null
    highest_since_entry?: number | null
    tp1_price?: number | null
    tp2_price?: number | null
    tp3_price?: number | null
    tp4_price?: number | null
    manual_tp_price?: number | null
    planned_take_profit?: S12PlannedTakeProfit | string | null
    tp1_source?: string | null
    s12_tp1_source?: string | null
    s12_pressure_tp1?: number | null
    s12_pressure_tp1_source?: string | null
    s12_main_exit_source?: string | null
    fusion_runner_tp1?: number | null
    fusion_runner_tp1_source?: string | null
    tp1_hit?: number | null
    s12_position_stop_price?: number | null
    s12_position_stop_source?: S12PositionStopSource | string | null
    s12_position_stop_method?: string | null
    position_opened_today?: boolean | null
  }
}

export interface S12PositionStopPlan {
  price: number
  source: Exclude<S12PositionStopSource, 'adaptive'>
  method: Exclude<S12StructureExitPlan['trailingStop']['method'], 'structure_stop_then_15m_higher_low_atr_vwap'>
  zoneLow: number
  zoneHigh: number
  noAtrBuffer: true
}

interface S12IntradayInput {
  symbol: string
  bars15m: S12Bar[]
  bars1h: S12Bar[]
  bars4h?: S12Bar[]
  barsSession60?: S12Bar[]
  bars1d?: S12Bar[]
  fallback15mBars?: S12Bar[]
  fallback1hBars?: S12Bar[]
  nowMs?: number
  min15mBars?: number
  policy?: Partial<S12TimingPolicy> | null
  h4Source?: S12H4Source
  sessionContextSource?: S12IntradayAssessment['sessionContextSource']
  h4ReferenceDate?: string | null
  h4ReferenceClose?: number | null
  barDiagnostics?: S12RuntimeBarDiagnostics | null
}

interface S12FromBaseBarsInput {
  symbol: string
  baseBars: S12Bar[]
  fallback15mBars?: S12Bar[]
  fallback4hBars?: S12Bar[]
  fallbackDailyBars?: S12Bar[]
  fallback1hBars?: S12Bar[]
  nowMs?: number
  policy?: Partial<S12TimingPolicy> | null
  barDiagnostics?: S12RuntimeBarDiagnostics | null
  h4ReferenceDate?: string | null
  h4ReferenceClose?: number | null
}

interface S12AggregationOptions {
  alignToTwSession?: boolean
}

type S12Bias4h = S12HtfBias

const M15_MS = 15 * 60_000
const H1_MS = 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const TW_OFFSET_MS = 8 * H1_MS
const TW_SESSION_OPEN_MS = 9 * H1_MS
const TW_SESSION_CLOSE_MS = (13 * 60 + 30) * 60_000

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function enabledFlag(value: unknown, fallback: boolean): boolean {
  if (value == null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const key = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(key)) return true
  if (['0', 'false', 'no', 'off'].includes(key)) return false
  return fallback
}

function normalizePositionStopSource(value: unknown): S12PositionStopSource {
  const key = String(value ?? DEFAULT_S12_TIMING_POLICY.positionStopSource).trim()
  if (key === '15m_protected_low') return '15m_protected_low'
  if (key === '15m_recent_fvg') return '15m_recent_fvg'
  if (key === '15m_order_block') return '15m_order_block'
  return 'adaptive'
}

function normalizePlannedTakeProfit(value: unknown): S12PlannedTakeProfit {
  const key = String(value ?? DEFAULT_S12_TIMING_POLICY.plannedTakeProfit).trim().toLowerCase()
  if (key === 'tp3') return 'tp3'
  if (key === 'tp4') return 'tp4'
  return 'tp2'
}

export function normalizeS12TimingPolicy(policy: Partial<S12TimingPolicy> | null | undefined): S12TimingPolicy {
  return {
    min15mBars: boundedInt(policy?.min15mBars, DEFAULT_S12_TIMING_POLICY.min15mBars, 3, 12),
    seededFastMaturityEnabled: enabledFlag(policy?.seededFastMaturityEnabled, DEFAULT_S12_TIMING_POLICY.seededFastMaturityEnabled),
    seededMin15mBars: boundedInt(policy?.seededMin15mBars, DEFAULT_S12_TIMING_POLICY.seededMin15mBars, 3, 6),
    atr15mBars: boundedInt(policy?.atr15mBars, DEFAULT_S12_TIMING_POLICY.atr15mBars, 5, 30),
    zoneAtrBars: boundedInt(policy?.zoneAtrBars, DEFAULT_S12_TIMING_POLICY.zoneAtrBars, 5, 20),
    rvolLookbackBars: boundedInt(policy?.rvolLookbackBars, DEFAULT_S12_TIMING_POLICY.rvolLookbackBars, 5, 40),
    swingLookbackBars: boundedInt(policy?.swingLookbackBars, DEFAULT_S12_TIMING_POLICY.swingLookbackBars, 2, 12),
    srPivotLen: boundedInt(policy?.srPivotLen, DEFAULT_S12_TIMING_POLICY.srPivotLen, 3, 20),
    srAtrLen: boundedInt(policy?.srAtrLen, DEFAULT_S12_TIMING_POLICY.srAtrLen, 5, 30),
    srZoneAtr: Math.max(0.05, Math.min(1.0, Number(policy?.srZoneAtr ?? DEFAULT_S12_TIMING_POLICY.srZoneAtr))),
    srMergeDistanceAtr: Math.max(0.1, Math.min(3.0, Number(policy?.srMergeDistanceAtr ?? DEFAULT_S12_TIMING_POLICY.srMergeDistanceAtr))),
    srBreakBufferAtr: Math.max(0.01, Math.min(1.0, Number(policy?.srBreakBufferAtr ?? DEFAULT_S12_TIMING_POLICY.srBreakBufferAtr))),
    srBreakConfirmBars: boundedInt(policy?.srBreakConfirmBars, DEFAULT_S12_TIMING_POLICY.srBreakConfirmBars, 1, 5),
    obLookbackBars: boundedInt(policy?.obLookbackBars, DEFAULT_S12_TIMING_POLICY.obLookbackBars, 5, 80),
    minFvgAtr: Math.max(0.01, Math.min(0.5, Number(policy?.minFvgAtr ?? DEFAULT_S12_TIMING_POLICY.minFvgAtr))),
    maxVisibleZones: boundedInt(policy?.maxVisibleZones, DEFAULT_S12_TIMING_POLICY.maxVisibleZones, 1, 10),
    positionStopSource: normalizePositionStopSource(policy?.positionStopSource),
    plannedTakeProfit: normalizePlannedTakeProfit(policy?.plannedTakeProfit),
    manualTakeProfitPrice: null,
    coachMaxWaitBars: boundedInt(policy?.coachMaxWaitBars, DEFAULT_S12_TIMING_POLICY.coachMaxWaitBars, 20, 240),
    triggerMode: String(policy?.triggerMode ?? DEFAULT_S12_TIMING_POLICY.triggerMode).trim() === 'reaction_close' ? 'reaction_close' : 'touch',
    priorDirectionalBars: boundedInt(policy?.priorDirectionalBars, DEFAULT_S12_TIMING_POLICY.priorDirectionalBars, 1, 6),
    zoneTouchStaleBars: boundedInt(policy?.zoneTouchStaleBars, DEFAULT_S12_TIMING_POLICY.zoneTouchStaleBars, 4, 40),
    sweepWaitBars: boundedInt(policy?.sweepWaitBars, DEFAULT_S12_TIMING_POLICY.sweepWaitBars, 4, 40),
    chochWaitBars: boundedInt(policy?.chochWaitBars, DEFAULT_S12_TIMING_POLICY.chochWaitBars, 4, 30),
    bosWaitBars: boundedInt(policy?.bosWaitBars, DEFAULT_S12_TIMING_POLICY.bosWaitBars, 6, 60),
    retestWaitBars: boundedInt(policy?.retestWaitBars, DEFAULT_S12_TIMING_POLICY.retestWaitBars, 4, 40),
    fullCoverage15mBars: boundedInt(policy?.fullCoverage15mBars, DEFAULT_S12_TIMING_POLICY.fullCoverage15mBars, 4, 40),
    fullCoverage1hBars: boundedInt(policy?.fullCoverage1hBars, DEFAULT_S12_TIMING_POLICY.fullCoverage1hBars, 1, 8),
    fullCoverageSession60Bars: boundedInt(policy?.fullCoverageSession60Bars, DEFAULT_S12_TIMING_POLICY.fullCoverageSession60Bars, 1, 4),
    minFastVwapSignals: boundedInt(policy?.minFastVwapSignals, DEFAULT_S12_TIMING_POLICY.minFastVwapSignals, 1, 5),
    maxFastVwapBlockers: boundedInt(policy?.maxFastVwapBlockers, DEFAULT_S12_TIMING_POLICY.maxFastVwapBlockers, 0, 3),
    slowVwapSupportiveRatio: Math.max(0.4, Math.min(0.9, Number(policy?.slowVwapSupportiveRatio ?? DEFAULT_S12_TIMING_POLICY.slowVwapSupportiveRatio))),
    slowVwapOverheadRatio: Math.max(0.05, Math.min(0.4, Number(policy?.slowVwapOverheadRatio ?? DEFAULT_S12_TIMING_POLICY.slowVwapOverheadRatio))),
    volumeExpansionMin: Math.max(1, Math.min(3, Number(policy?.volumeExpansionMin ?? DEFAULT_S12_TIMING_POLICY.volumeExpansionMin))),
    repricingBreakoutAtr: Math.max(0, Math.min(0.5, Number(policy?.repricingBreakoutAtr ?? DEFAULT_S12_TIMING_POLICY.repricingBreakoutAtr))),
    sessionAcceptanceMinMoveAtr: Math.max(0.1, Math.min(1.5, Number(policy?.sessionAcceptanceMinMoveAtr ?? DEFAULT_S12_TIMING_POLICY.sessionAcceptanceMinMoveAtr))),
    sessionAcceptanceMinClosePosition: Math.max(0.55, Math.min(0.95, Number(policy?.sessionAcceptanceMinClosePosition ?? DEFAULT_S12_TIMING_POLICY.sessionAcceptanceMinClosePosition))),
    sessionLockToleranceAtr: Math.max(0.005, Math.min(0.15, Number(policy?.sessionLockToleranceAtr ?? DEFAULT_S12_TIMING_POLICY.sessionLockToleranceAtr))),
    sessionLockTolerancePct: Math.max(0.0001, Math.min(0.005, Number(policy?.sessionLockTolerancePct ?? DEFAULT_S12_TIMING_POLICY.sessionLockTolerancePct))),
    sessionLockMinBars: boundedInt(policy?.sessionLockMinBars, DEFAULT_S12_TIMING_POLICY.sessionLockMinBars, 2, 4),
    strongClosePosition: Math.max(0.5, Math.min(0.9, Number(policy?.strongClosePosition ?? DEFAULT_S12_TIMING_POLICY.strongClosePosition))),
    strongBodyPct: Math.max(0.1, Math.min(0.8, Number(policy?.strongBodyPct ?? DEFAULT_S12_TIMING_POLICY.strongBodyPct))),
    higherLowAtrTolerance: Math.max(0, Math.min(0.5, Number(policy?.higherLowAtrTolerance ?? DEFAULT_S12_TIMING_POLICY.higherLowAtrTolerance))),
    maxStopRiskPct: Math.max(0.015, Math.min(0.1, Number(policy?.maxStopRiskPct ?? DEFAULT_S12_TIMING_POLICY.maxStopRiskPct))),
    maxStopRiskAtr: Math.max(0.5, Math.min(6, Number(policy?.maxStopRiskAtr ?? DEFAULT_S12_TIMING_POLICY.maxStopRiskAtr))),
    strictMutationMinScore: boundedInt(policy?.strictMutationMinScore, DEFAULT_S12_TIMING_POLICY.strictMutationMinScore, 3, 8),
    limitedMutationMinScore: boundedInt(policy?.limitedMutationMinScore, DEFAULT_S12_TIMING_POLICY.limitedMutationMinScore, 2, 7),
    strictSizeMultiplier: Math.max(0.1, Math.min(1, Number(policy?.strictSizeMultiplier ?? DEFAULT_S12_TIMING_POLICY.strictSizeMultiplier))),
    limitedSizeMultiplier: Math.max(0.1, Math.min(0.8, Number(policy?.limitedSizeMultiplier ?? DEFAULT_S12_TIMING_POLICY.limitedSizeMultiplier))),
    chaseAtrMultiplier: Math.max(0, Math.min(1, Number(policy?.chaseAtrMultiplier ?? DEFAULT_S12_TIMING_POLICY.chaseAtrMultiplier))),
    stopStructureBufferAtr: Math.max(0, Math.min(0.5, Number(policy?.stopStructureBufferAtr ?? DEFAULT_S12_TIMING_POLICY.stopStructureBufferAtr))),
    fullCoverage4hBars: boundedInt(policy?.fullCoverageSession60Bars ?? policy?.fullCoverage4hBars, DEFAULT_S12_TIMING_POLICY.fullCoverageSession60Bars, 1, 4),
  }
}

export function s12TimingPolicyFromEnv(env: Record<string, unknown> | null | undefined): S12TimingPolicy {
  return normalizeS12TimingPolicy({
    min15mBars: env?.S12_INTRADAY_MIN_15M_BARS as number | undefined,
    seededFastMaturityEnabled: env?.S12_INTRADAY_PREVIOUS_SESSION_FAST_MATURITY_ENABLED as boolean | undefined,
    seededMin15mBars: env?.S12_INTRADAY_PREVIOUS_SESSION_MIN_15M_BARS as number | undefined,
    atr15mBars: env?.S12_INTRADAY_ATR_15M_BARS as number | undefined,
    zoneAtrBars: env?.S12_INTRADAY_ZONE_ATR_BARS as number | undefined,
    rvolLookbackBars: env?.S12_INTRADAY_RVOL_LOOKBACK_BARS as number | undefined,
    swingLookbackBars: env?.S12_INTRADAY_SWING_LOOKBACK_BARS as number | undefined,
    srPivotLen: env?.S12_INTRADAY_SR_PIVOT_LEN as number | undefined,
    srAtrLen: env?.S12_INTRADAY_SR_ATR_LEN as number | undefined,
    srZoneAtr: env?.S12_INTRADAY_SR_ZONE_ATR as number | undefined,
    srMergeDistanceAtr: env?.S12_INTRADAY_SR_MERGE_DISTANCE_ATR as number | undefined,
    srBreakBufferAtr: env?.S12_INTRADAY_SR_BREAK_BUFFER_ATR as number | undefined,
    srBreakConfirmBars: env?.S12_INTRADAY_SR_BREAK_CONFIRM_BARS as number | undefined,
    obLookbackBars: env?.S12_INTRADAY_OB_LOOKBACK_BARS as number | undefined,
    minFvgAtr: env?.S12_INTRADAY_MIN_FVG_ATR as number | undefined,
    maxVisibleZones: env?.S12_INTRADAY_MAX_VISIBLE_ZONES as number | undefined,
    positionStopSource: env?.S12_POSITION_STOP_SOURCE as S12PositionStopSource | undefined,
    plannedTakeProfit: env?.S12_POSITION_PLANNED_TP as S12PlannedTakeProfit | undefined,
    coachMaxWaitBars: env?.S12_INTRADAY_COACH_MAX_WAIT_BARS as number | undefined,
    triggerMode: env?.S12_INTRADAY_TRIGGER_MODE as S12TimingPolicy['triggerMode'] | undefined,
    priorDirectionalBars: env?.S12_INTRADAY_PRIOR_DIRECTION_BARS as number | undefined,
    zoneTouchStaleBars: env?.S12_INTRADAY_ZONE_TOUCH_STALE_BARS as number | undefined,
    sweepWaitBars: env?.S12_INTRADAY_SWEEP_WAIT_BARS as number | undefined,
    chochWaitBars: env?.S12_INTRADAY_CHOCH_WAIT_BARS as number | undefined,
    bosWaitBars: env?.S12_INTRADAY_BOS_WAIT_BARS as number | undefined,
    retestWaitBars: env?.S12_INTRADAY_RETEST_WAIT_BARS as number | undefined,
    fullCoverage15mBars: env?.S12_INTRADAY_FULL_COVERAGE_15M_BARS as number | undefined,
    fullCoverage1hBars: env?.S12_INTRADAY_FULL_COVERAGE_1H_BARS as number | undefined,
    fullCoverageSession60Bars: env?.S12_INTRADAY_FULL_COVERAGE_SESSION_60M_BARS as number | undefined,
    minFastVwapSignals: env?.S12_TW_MIN_FAST_VWAP_SIGNALS as number | undefined,
    maxFastVwapBlockers: env?.S12_TW_MAX_FAST_VWAP_BLOCKERS as number | undefined,
    slowVwapSupportiveRatio: env?.S12_TW_SLOW_VWAP_SUPPORTIVE_RATIO as number | undefined,
    slowVwapOverheadRatio: env?.S12_TW_SLOW_VWAP_OVERHEAD_RATIO as number | undefined,
    volumeExpansionMin: env?.S12_TW_VOLUME_EXPANSION_MIN as number | undefined,
    repricingBreakoutAtr: env?.S12_TW_REPRICING_BREAKOUT_ATR as number | undefined,
    sessionAcceptanceMinMoveAtr: env?.S12_TW_SESSION_ACCEPTANCE_MIN_MOVE_ATR as number | undefined,
    sessionAcceptanceMinClosePosition: env?.S12_TW_SESSION_ACCEPTANCE_MIN_CLOSE_POSITION as number | undefined,
    sessionLockToleranceAtr: env?.S12_TW_SESSION_LOCK_TOLERANCE_ATR as number | undefined,
    sessionLockTolerancePct: env?.S12_TW_SESSION_LOCK_TOLERANCE_PCT as number | undefined,
    sessionLockMinBars: env?.S12_TW_SESSION_LOCK_MIN_BARS as number | undefined,
    strongClosePosition: env?.S12_TW_STRONG_CLOSE_POSITION as number | undefined,
    strongBodyPct: env?.S12_TW_STRONG_BODY_PCT as number | undefined,
    higherLowAtrTolerance: env?.S12_TW_HIGHER_LOW_ATR_TOLERANCE as number | undefined,
    maxStopRiskPct: env?.S12_TW_MAX_STOP_RISK_PCT as number | undefined,
    maxStopRiskAtr: env?.S12_TW_MAX_STOP_RISK_ATR as number | undefined,
    strictMutationMinScore: env?.S12_TW_STRICT_MUTATION_MIN_SCORE as number | undefined,
    limitedMutationMinScore: env?.S12_TW_LIMITED_MUTATION_MIN_SCORE as number | undefined,
    strictSizeMultiplier: env?.S12_TW_STRICT_SIZE_MULTIPLIER as number | undefined,
    limitedSizeMultiplier: env?.S12_TW_LIMITED_SIZE_MULTIPLIER as number | undefined,
    chaseAtrMultiplier: env?.S12_TW_CHASE_ATR_MULTIPLIER as number | undefined,
    stopStructureBufferAtr: env?.S12_TW_STOP_STRUCTURE_BUFFER_ATR as number | undefined,
  })
}

function inputTimingPolicy(input: Pick<S12IntradayInput, 'min15mBars' | 'policy'>): S12TimingPolicy {
  return normalizeS12TimingPolicy({
    ...(input.policy ?? {}),
    min15mBars: input.min15mBars ?? input.policy?.min15mBars,
  })
}

function timingPolicyDetail(policy: S12TimingPolicy): Record<string, unknown> {
  return {
    policy_min15m_bars: policy.min15mBars,
    policy_seeded_fast_maturity_enabled: policy.seededFastMaturityEnabled ? 'true' : 'false',
    policy_seeded_min15m_bars: policy.seededMin15mBars,
    policy_atr15m_bars: policy.atr15mBars,
    policy_zone_atr_bars: policy.zoneAtrBars,
    policy_rvol_lookback_bars: policy.rvolLookbackBars,
    policy_swing_lookback_bars: policy.swingLookbackBars,
    policy_sr_pivot_len: policy.srPivotLen,
    policy_sr_atr_len: policy.srAtrLen,
    policy_sr_zone_atr: policy.srZoneAtr,
    policy_sr_merge_distance_atr: policy.srMergeDistanceAtr,
    policy_sr_break_buffer_atr: policy.srBreakBufferAtr,
    policy_sr_break_confirm_bars: policy.srBreakConfirmBars,
    policy_ob_lookback_bars: policy.obLookbackBars,
    policy_min_fvg_atr: policy.minFvgAtr,
    policy_max_visible_zones: policy.maxVisibleZones,
    policy_position_stop_source: policy.positionStopSource,
    policy_planned_take_profit: policy.plannedTakeProfit,
    policy_manual_take_profit_price: null,
    policy_coach_max_wait_bars: policy.coachMaxWaitBars,
    policy_trigger_mode: policy.triggerMode,
    policy_prior_direction_bars: policy.priorDirectionalBars,
    policy_zone_touch_stale_bars: policy.zoneTouchStaleBars,
    policy_sweep_wait_bars: policy.sweepWaitBars,
    policy_choch_wait_bars: policy.chochWaitBars,
    policy_bos_wait_bars: policy.bosWaitBars,
    policy_retest_wait_bars: policy.retestWaitBars,
    policy_context_timeframe: 'tw_equity_session_60m',
    policy_full_coverage_session_60m_bars: policy.fullCoverageSession60Bars,
    policy_min_fast_vwap_signals: policy.minFastVwapSignals,
    policy_max_fast_vwap_blockers: policy.maxFastVwapBlockers,
    policy_session_acceptance_min_move_atr: policy.sessionAcceptanceMinMoveAtr,
    policy_session_acceptance_min_close_position: policy.sessionAcceptanceMinClosePosition,
    policy_session_lock_tolerance_atr: policy.sessionLockToleranceAtr,
    policy_session_lock_tolerance_pct: policy.sessionLockTolerancePct,
    policy_session_lock_min_bars: policy.sessionLockMinBars,
    policy_max_stop_risk_pct: policy.maxStopRiskPct,
    policy_max_stop_risk_atr: policy.maxStopRiskAtr,
    policy_strict_mutation_min_score: policy.strictMutationMinScore,
    policy_limited_mutation_min_score: policy.limitedMutationMinScore,
  }
}

function effectiveMin15mBarsForSeed(policy: S12TimingPolicy, hasPreviousSession1hSeed: boolean): number {
  if (!policy.seededFastMaturityEnabled || !hasPreviousSession1hSeed) return policy.min15mBars
  return Math.min(policy.min15mBars, policy.seededMin15mBars)
}

function shouldBlockOnSession60BearishRisk(
  source: S12IntradayAssessment['sessionContextSource'],
  bias: S12HtfBias,
): boolean {
  return source === 'current_session_60m'
    && bias.direction === 'short'
    && bias.confidence === 'confirmed'
}

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function price(value: number | null | undefined): number | null {
  return value == null || !Number.isFinite(value) ? null : round(value, 2)
}

function normalizeExitPlanForTwEquity(
  plan: S12StructureExitPlan,
  entryPrice: number | null,
  referencePrice: number | null,
): S12StructureExitPlan {
  const band = referencePrice != null && referencePrice > 0 ? resolveTwEquityPriceBand(referencePrice) : null
  const target = (value: number | null): number | null => {
    if (value == null || value <= 0) return null
    const normalized = normalizeTwEquityTargetPrice(value, band)
    return entryPrice != null && normalized <= entryPrice ? null : normalized
  }
  const stop = plan.trailingStop.initial == null
    ? null
    : normalizeTwEquityStopPrice(plan.trailingStop.initial, band)
  return {
    ...plan,
    tp1: { ...plan.tp1, price: target(plan.tp1.price) },
    mainExit: {
      ...plan.mainExit,
      price: target(plan.mainExit.price),
      zoneLow: plan.mainExit.zoneLow == null ? null : normalizeTwEquityTargetPrice(plan.mainExit.zoneLow, band),
      zoneHigh: plan.mainExit.zoneHigh == null ? null : normalizeTwEquityTargetPrice(plan.mainExit.zoneHigh, band),
    },
    tp3: { ...plan.tp3, price: target(plan.tp3.price) },
    tp4: { ...plan.tp4, price: target(plan.tp4.price) },
    trailingStop: {
      ...plan.trailingStop,
      initial: entryPrice != null && stop != null && stop >= entryPrice ? null : stop,
    },
  }
}

function roundLot(value: number): number {
  return Math.floor(Math.max(0, value) / 1000) * 1000
}

function partialTakeProfitShares(params: {
  shares: number
  originalShares: number
  sellRatio: number
}): number {
  const shares = Math.max(0, Math.floor(params.shares))
  const originalShares = Math.max(0, Math.floor(params.originalShares || shares))
  if (shares <= 1) return shares

  const raw = Math.max(1, Math.floor(originalShares * params.sellRatio))
  const partial = raw >= 1000
    ? roundLot(raw)
    : raw
  const bounded = Math.min(shares - 1, Math.max(1, partial))
  return bounded > 0 && bounded < shares ? bounded : shares
}

function resolveTakeProfitFusion(params: {
  entryPrice: number
  currentPrice: number
  positionTp1: number | null
  pressureTp1: number | null
  runnerTp1: number | null
  assessmentMainExit: number | null
  positionTp1Source: string | null
  pressureTp1Source: string | null
  assessmentMainExitSource: string | null
  structuralStop: number | null
  initialStop: number | null
  atr: number | null
  tp1Hit: boolean
  openedToday: boolean
  bearishDefenseReady: boolean
  dailyWeak: boolean
  session60Weak: boolean
  rvolState: string | null | undefined
  vwapStack: string | null | undefined
  nearestAboveSource: string | null | undefined
  sellRatio: number
}): {
  structuralTp1Touched: boolean
  executableTargetTouched: boolean
  executableTarget: number | null
  executableTargetSource: string | null
  shouldTakeProfit: boolean
  pressureOnly: boolean
  confluenceScore: number
  profitR: number | null
  gainPct: number
  minProfitR: number
  minGainPct: number
  minConfluence: number
  sellRatio: number
  reasons: string[]
  pressureSources: string[]
} {
  const structuralTp1 = params.pressureTp1
  const structuralTp1Touched =
    !params.tp1Hit &&
    structuralTp1 != null &&
    structuralTp1 > params.entryPrice &&
    params.currentPrice >= structuralTp1

  const pressureSource = params.pressureTp1Source ?? 'structural_tp1'
  const structuralExecutable =
    structuralTp1Touched &&
    !['15m_previous_high', 'tp_ladder', 's12_structure_exit_plan'].includes(pressureSource)
  const runnerTouched =
    !params.tp1Hit &&
    params.runnerTp1 != null &&
    params.runnerTp1 > params.entryPrice &&
    params.currentPrice >= params.runnerTp1
  const executableTarget = structuralExecutable
    ? structuralTp1
    : runnerTouched
      ? params.runnerTp1
      : null
  const executableTargetSource = structuralExecutable
    ? pressureSource
    : runnerTouched
      ? params.positionTp1Source ?? 'runner_target'
      : null
  const executableTargetTouched = executableTarget != null

  const gainPct = (params.currentPrice - params.entryPrice) / params.entryPrice
  const belowEntryStop =
    [params.initialStop, params.structuralStop]
      .filter((value): value is number => value != null && value > 0 && value < params.entryPrice)
      .sort((a, b) => b - a)[0] ?? null
  const riskAmount =
    belowEntryStop != null
      ? params.entryPrice - belowEntryStop
      : params.atr != null
        ? params.atr
        : params.entryPrice * 0.02
  const profitR = riskAmount > 0 ? (params.currentPrice - params.entryPrice) / riskAmount : null

  const reasons: string[] = []
  const pressureSources: string[] = []
  let confluenceScore = 0

  if (structuralTp1Touched) {
    pressureSources.push(pressureSource)
    reasons.push(`near_pressure:${pressureSource}`)
    confluenceScore += pressureSource === '15m_previous_high' ? 1 : 2
  }
  if (runnerTouched) {
    const source = params.positionTp1Source ?? 'runner_target'
    pressureSources.push(source)
    reasons.push(`runner_target:${source}`)
    confluenceScore += 2
  }
  if (
    params.assessmentMainExit != null &&
    params.currentPrice >= params.assessmentMainExit * 0.995
  ) {
    const source = params.assessmentMainExitSource ?? 'main_exit'
    pressureSources.push(source)
    reasons.push(`main_exit_source:${source}`)
    confluenceScore += source === '1h_supply_zone' ? 2 : 1
  }
  if (params.bearishDefenseReady) {
    reasons.push('bearish_defense_ready')
    confluenceScore += 1
  }
  if (params.dailyWeak && params.session60Weak && gainPct > 0) {
    reasons.push('daily_session_60m_profit_protect')
    confluenceScore += 1
  }
  if (['normal', 'active', 'high'].includes(String(params.rvolState ?? '').toLowerCase())) {
    reasons.push(`rvol:${params.rvolState}`)
    confluenceScore += 1
  }
  if (['mixed', 'bearish', 'resistance_above'].includes(String(params.vwapStack ?? '').toLowerCase())) {
    reasons.push(`vwap_stack:${params.vwapStack}`)
    confluenceScore += 1
  }
  if (params.nearestAboveSource && /vwap|previous|supply/i.test(params.nearestAboveSource)) {
    reasons.push(`nearest_above:${params.nearestAboveSource}`)
    confluenceScore += 1
  }

  const minConfluence = params.openedToday ? 3 : 2
  const minProfitR = params.openedToday ? 1 : 0.6
  const minGainPct = params.openedToday ? 0.012 : 0.008
  const profitGate = gainPct >= minGainPct || (profitR != null && profitR >= minProfitR)
  const shouldTakeProfit =
    executableTargetTouched &&
    profitGate &&
    confluenceScore >= minConfluence
  return {
    structuralTp1Touched,
    executableTargetTouched,
    executableTarget,
    executableTargetSource,
    shouldTakeProfit,
    pressureOnly: (structuralTp1Touched || executableTargetTouched) && !shouldTakeProfit,
    confluenceScore,
    profitR,
    gainPct,
    minProfitR,
    minGainPct,
    minConfluence,
    sellRatio: params.openedToday ? Math.min(params.sellRatio, 0.3) : params.sellRatio,
    reasons,
    pressureSources,
  }
}

function boundedRatio(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0.05, Math.min(0.95, n))
}

function s12DecisionDetail(parts: Record<string, unknown>): string {
  return detailText(parts)
}

function normalizeBars(bars: S12Bar[]): S12Bar[] {
  return [...bars]
    .filter((bar) => (
      Number.isFinite(bar.startMs) &&
      finitePositive(bar.open) != null &&
      finitePositive(bar.high) != null &&
      finitePositive(bar.low) != null &&
      finitePositive(bar.close) != null &&
      bar.high >= bar.low
    ))
    .map((bar) => ({
      startMs: Number(bar.startMs),
      open: Number(bar.open),
      high: Math.max(Number(bar.high), Number(bar.open), Number(bar.close)),
      low: Math.min(Number(bar.low), Number(bar.open), Number(bar.close)),
      close: Number(bar.close),
      volume: Math.max(0, Number(bar.volume ?? 0)),
    }))
    .sort((a, b) => a.startMs - b.startMs)
}

export function aggregateCompletedS12Bars(
  bars: S12Bar[],
  timeframeMs: number,
  nowMs = Date.now(),
  options: S12AggregationOptions = {},
): S12Bar[] {
  const tf = Math.max(60_000, Math.floor(timeframeMs))
  const buckets = new Map<number, S12Bar>()
  for (const bar of normalizeBars(bars)) {
    const startMs = options.alignToTwSession
      ? twSessionBucketStartMs(bar.startMs, tf)
      : Math.floor(bar.startMs / tf) * tf
    if (startMs == null) continue
    if (startMs + tf > nowMs) continue
    const existing = buckets.get(startMs)
    if (!existing) {
      buckets.set(startMs, { ...bar, startMs })
      continue
    }
    existing.high = Math.max(existing.high, bar.high)
    existing.low = Math.min(existing.low, bar.low)
    existing.close = bar.close
    existing.volume = Math.max(0, Number(existing.volume ?? 0)) + Math.max(0, Number(bar.volume ?? 0))
  }
  return [...buckets.values()].sort((a, b) => a.startMs - b.startMs)
}

function twLocalDayStartUtcMs(ms: number): number {
  return Math.floor((ms + TW_OFFSET_MS) / DAY_MS) * DAY_MS - TW_OFFSET_MS
}

function twSessionBucketStartMs(ms: number, timeframeMs: number): number | null {
  const dayStart = twLocalDayStartUtcMs(ms)
  const sessionOpen = dayStart + TW_SESSION_OPEN_MS
  const sessionClose = dayStart + TW_SESSION_CLOSE_MS
  if (ms < sessionOpen || ms >= sessionClose) return null
  const elapsed = ms - sessionOpen
  return sessionOpen + Math.floor(elapsed / timeframeMs) * timeframeMs
}

function sessionAggregationDiagnostics(baseBars: S12Bar[], nowMs: number): S12RuntimeBarDiagnostics {
  const normalized = normalizeBars(baseBars)
  const inSession = normalized.filter((bar) => twSessionBucketStartMs(bar.startMs, M15_MS) != null)
  const future = normalized.filter((bar) => bar.startMs > nowMs)
  return {
    normalized_base_bars_count: normalized.length,
    in_session_base_bars_count: inSession.length,
    dropped_outside_session_count: Math.max(0, normalized.length - inSession.length),
    future_base_bars_count: future.length,
    first_base_bar_tw: normalized.length ? new Date(normalized[0].startMs + TW_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19) : null,
    last_base_bar_tw: normalized.length ? new Date(normalized[normalized.length - 1].startMs + TW_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19) : null,
  }
}

function aggregateTwDailyS12Bars(bars: S12Bar[], nowMs = Date.now()): S12Bar[] {
  const buckets = new Map<number, S12Bar>()
  for (const bar of normalizeBars(bars)) {
    const sessionStart = twLocalDayStartUtcMs(bar.startMs) + TW_SESSION_OPEN_MS
    if (bar.startMs > nowMs) continue
    const existing = buckets.get(sessionStart)
    if (!existing) {
      buckets.set(sessionStart, { ...bar, startMs: sessionStart })
      continue
    }
    existing.high = Math.max(existing.high, bar.high)
    existing.low = Math.min(existing.low, bar.low)
    existing.close = bar.close
    existing.volume = Math.max(0, Number(existing.volume ?? 0)) + Math.max(0, Number(bar.volume ?? 0))
  }
  return [...buckets.values()].sort((a, b) => a.startMs - b.startMs)
}

function trueRange(bar: S12Bar, previousClose: number | null): number {
  if (previousClose == null) return bar.high - bar.low
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - previousClose),
    Math.abs(bar.low - previousClose),
  )
}

function averageTrueRange(bars: S12Bar[], period = 14): number | null {
  const clean = normalizeBars(bars)
  if (clean.length === 0) return null
  const slice = clean.slice(-Math.max(1, period))
  let previousClose: number | null = clean[Math.max(0, clean.length - slice.length - 1)]?.close ?? null
  const ranges: number[] = []
  for (const bar of slice) {
    ranges.push(trueRange(bar, previousClose))
    previousClose = bar.close
  }
  return ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : null
}

function highBetween(bars: S12Bar[], start: number, endExclusive: number): number | null {
  const slice = bars.slice(Math.max(0, start), Math.max(0, endExclusive))
  return slice.length ? Math.max(...slice.map((bar) => bar.high)) : null
}

function lowBetween(bars: S12Bar[], start: number, endExclusive: number): number | null {
  const slice = bars.slice(Math.max(0, start), Math.max(0, endExclusive))
  return slice.length ? Math.min(...slice.map((bar) => bar.low)) : null
}

function overlapsZone(bar: S12Bar, zone: S12IntradayZone): boolean {
  return bar.low <= zone.high && bar.high >= zone.low
}

function zoneOverlapCoverage(a: S12IntradayZone | null | undefined, b: S12IntradayZone | null | undefined): number {
  if (!a || !b) return 0
  const intersection = Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low))
  const aWidth = Math.max(0.0001, a.high - a.low)
  const bWidth = Math.max(0.0001, b.high - b.low)
  return Math.min(intersection / aWidth, intersection / bWidth)
}

function detailText(parts: Record<string, unknown>): string {
  return Object.entries(parts)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(';')
}

function detailWithOverrides(detail: string, parts: Record<string, unknown>): string {
  const patch = detailText(parts)
  return patch ? `${detail};${patch}` : detail
}

function maturityStage(state: S12IntradayState): S12IntradayAssessment['maturity']['stage'] {
  switch (state) {
    case 'waiting_15m_completed_bars':
    case 'waiting_session_60m_completed_bar':
    case 'waiting_4h_completed_bar':
    case 'waiting_1h_completed_bar':
      return 'data'
    case 'waiting_session_60m_long_bias':
    case 'waiting_session_60m_bearish_risk':
    case 'waiting_4h_long_bias':
      return 'higher_timeframe_bias'
    case 'waiting_1h_demand_zone':
    case 'waiting_15m_zone_touch':
      return 'setup'
    case 'waiting_sweep':
    case 'waiting_choch':
    case 'waiting_bos':
    case 'waiting_retest':
    case 'waiting_reaction':
      return 'trigger_sequence'
    case 'limited_takeover_ready':
    case 'reaction_ready':
      return 'ready'
    case 'bearish_defense_ready':
      return 'defensive'
    case 'invalidated':
      return 'invalidated'
  }
}

function maturityTakeoverRole(state: S12IntradayState): S12IntradayAssessment['maturity']['takeoverRole'] {
  switch (state) {
    case 'limited_takeover_ready':
    case 'reaction_ready':
      return 'long_entry'
    case 'bearish_defense_ready':
      return 'no_buy_defense'
    case 'invalidated':
      return 'invalidate'
    default:
      return 'none'
  }
}

function entryStateFor(state: S12IntradayState): NonNullable<S12IntradayAssessment['entryState']> {
  if (state === 'invalidated' || state === 'bearish_defense_ready') return 'INVALIDATED'
  if (state === 'reaction_ready' || state === 'limited_takeover_ready') return 'EXECUTABLE'
  if (state === 'waiting_reaction') return 'RETEST_ACCEPTED'
  if (['waiting_sweep', 'waiting_choch', 'waiting_bos', 'waiting_retest'].includes(state)) return 'REPRICING_OR_REVERSAL'
  if (['waiting_1h_demand_zone', 'waiting_15m_zone_touch'].includes(state)) return 'CONTEXT_ELIGIBLE'
  return 'OBSERVE'
}

function maturityTier(
  state: S12IntradayState,
  sequence: S12IntradayAssessment['sequence'] = {},
): Pick<S12IntradayAssessment['maturity'], 'tier' | 'riskMode' | 'takeoverRole'> {
  if (state === 'limited_takeover_ready') {
    return { tier: 'limited_takeover_ready', riskMode: 'reduced_size_tight_stop', takeoverRole: 'long_entry' }
  }
  if (state === 'reaction_ready') {
    return { tier: 'full_reaction_ready', riskMode: 'full_size_reaction', takeoverRole: 'long_entry' }
  }
  if (state === 'bearish_defense_ready') {
    return { tier: 'no_buy_defense', riskMode: 'defense_only', takeoverRole: 'no_buy_defense' }
  }
  if (state === 'invalidated') {
    return { tier: 'defensive_invalidation', riskMode: 'defense_only', takeoverRole: 'invalidate' }
  }
  return { tier: 'none', riskMode: 'none', takeoverRole: maturityTakeoverRole(state) }
}

function maturitySnapshot(
  state: S12IntradayState,
  sequence: S12IntradayAssessment['sequence'] = {},
  stale?: {
    stale: boolean
    staleReason?: string | null
    staleAfterBars?: number | null
    elapsedBars?: number | null
  },
): S12IntradayAssessment['maturity'] {
  const tier = maturityTier(state, sequence)
  return {
    takeoverEligible: tier.takeoverRole !== 'none',
    takeoverRole: tier.takeoverRole,
    tier: tier.tier,
    riskMode: tier.riskMode,
    policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
    blocker: state,
    stage: maturityStage(state),
    ...(stale?.stale
      ? {
        stale: true,
        staleReason: stale.staleReason ?? null,
        staleAfterBars: stale.staleAfterBars ?? null,
        elapsedBars: stale.elapsedBars ?? null,
      }
      : {}),
  }
}

function setupKey(symbol: string, ...parts: Array<number | null | undefined>): string {
  const suffix = parts
    .filter((value): value is number => Number.isFinite(Number(value)))
    .map((value) => Math.floor(Number(value) / 60_000).toString(36))
    .join('-')
  return `s12l-${symbol}-${suffix}`
}

function emptyQuality(): S12StructureQuality {
  return {
    vwap: { value: null, priceVsVwapPct: null, state: 'unavailable' },
    vwapContext: emptyVwapContext(),
    rvol: { value: null, state: 'unavailable', lookbackBars: 0 },
    notes: [],
  }
}

function emptyVwapMetric(): S12VwapMetric {
  return { value: null, priceVsPct: null, state: 'unavailable', bars: 0 }
}

function emptyVwapContext(): S12StructureQuality['vwapContext'] {
  return {
    schemaVersion: 's12_vwap_context_v1',
    session: emptyVwapMetric(),
    session60: emptyVwapMetric(),
    h1: emptyVwapMetric(),
    h4: emptyVwapMetric(),
    daily: emptyVwapMetric(),
    anchored: {
      day: emptyVwapMetric(),
      week: emptyVwapMetric(),
      month: emptyVwapMetric(),
      quarter: emptyVwapMetric(),
      year: emptyVwapMetric(),
    },
    rolling15m: {
      bars7: emptyVwapMetric(),
      bars30: emptyVwapMetric(),
      bars90: emptyVwapMetric(),
    },
    rollingDays: {
      days7: emptyVwapMetric(),
      days30: emptyVwapMetric(),
      days90: emptyVwapMetric(),
      days365: emptyVwapMetric(),
    },
    previousZones: { h1: null, h4: null, daily: null },
    previousPeriodZones: { day: null, week: null, month: null, quarter: null, year: null },
    initialBalance: { high: null, low: null, state: 'unavailable', bars: 0 },
    stackState: 'unavailable',
    confluenceWidthPct: null,
    nearestAbove: null,
    nearestBelow: null,
  }
}

function emptyExitPlan(defense: S12BearishDefense | null = null): S12StructureExitPlan {
  return {
    mode: 'structure_first_trailing_v1',
    tp1: { price: null, source: 'unavailable', action: 'partial_take_profit' },
    mainExit: { price: null, zoneLow: null, zoneHigh: null, source: 'unavailable', action: 'main_take_profit' },
    tp3: { price: null, source: 'unavailable', action: 'extended_take_profit' },
    tp4: { price: null, source: 'unavailable', action: 'extended_take_profit' },
    manualTp: { price: null, source: 'unavailable', action: 'manual_take_profit' },
    trailingStop: {
      initial: null,
      method: 'structure_stop_then_15m_higher_low_atr_vwap',
      source: 'adaptive',
      activation: 'after_tp1_or_reverse_choch',
    },
    reverseWarning: {
      state: defense?.state ?? null,
      action: defense?.ready ? 'EXIT_ON_REVERSE_BOS' : defense?.action ?? 'none',
      source: 'bearish_defense_sidecar',
    },
  }
}

function vwapForBars(barsInput: S12Bar[], latestPrice: number): S12VwapMetric {
  const bars = normalizeBars(barsInput)
  if (!bars.length || latestPrice <= 0) return emptyVwapMetric()
  const totalVolume = bars.reduce((sum, bar) => sum + Math.max(0, Number(bar.volume ?? 0)), 0)
  const weightedValue = bars.reduce((sum, bar) => sum + Math.max(0, Number(bar.volume ?? 0)) * bar.close, 0)
  const value = totalVolume > 0
    ? weightedValue / totalVolume
    : bars.reduce((sum, bar) => sum + bar.close, 0) / bars.length
  const priceVsPct = value > 0 ? (latestPrice - value) / value : null
  const state =
    priceVsPct == null
      ? 'unavailable'
      : priceVsPct > 0.001
        ? 'above'
        : priceVsPct < -0.001
          ? 'below'
          : 'flat'
  return {
    value: price(value),
    priceVsPct: priceVsPct == null ? null : round(priceVsPct, 4),
    state,
    bars: bars.length,
  }
}

function twPeriodKey(ms: number, period: 'day' | 'week' | 'month' | 'quarter' | 'year'): string {
  const tw = new Date(ms + TW_OFFSET_MS)
  const year = tw.getUTCFullYear()
  const month = tw.getUTCMonth() + 1
  if (period === 'day') return tw.toISOString().slice(0, 10)
  if (period === 'month') return `${year}-${String(month).padStart(2, '0')}`
  if (period === 'quarter') return `${year}-Q${Math.floor((month - 1) / 3) + 1}`
  if (period === 'year') return String(year)
  const day = tw.getUTCDay() || 7
  const monday = new Date(Date.UTC(year, tw.getUTCMonth(), tw.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - day + 1)
  return monday.toISOString().slice(0, 10)
}

function sameCurrentPeriodBars(
  barsInput: S12Bar[],
  latestMs: number,
  period: 'day' | 'week' | 'month' | 'quarter' | 'year',
): S12Bar[] {
  const key = twPeriodKey(latestMs, period)
  return normalizeBars(barsInput).filter((bar) => twPeriodKey(bar.startMs, period) === key)
}

function rollingDayBars(barsInput: S12Bar[], latestMs: number, days: number): S12Bar[] {
  const cutoff = latestMs - days * DAY_MS
  return normalizeBars(barsInput).filter((bar) => bar.startMs >= cutoff && bar.startMs <= latestMs)
}

function weightedStdDevForBars(barsInput: S12Bar[], center: number): number | null {
  const bars = normalizeBars(barsInput)
  if (!bars.length || center <= 0) return null
  const volumeSum = bars.reduce((sum, bar) => sum + Math.max(0, Number(bar.volume ?? 0)), 0)
  if (volumeSum > 0) {
    const variance = bars.reduce((sum, bar) => {
      const volume = Math.max(0, Number(bar.volume ?? 0))
      return sum + volume * Math.pow(bar.close - center, 2)
    }, 0) / volumeSum
    return Math.sqrt(Math.max(0, variance))
  }
  const variance = bars.reduce((sum, bar) => sum + Math.pow(bar.close - center, 2), 0) / bars.length
  return Math.sqrt(Math.max(0, variance))
}

function vwapZoneForBars(
  barsInput: S12Bar[],
  latestPrice: number,
  source: S12VwapZone['source'],
): S12VwapZone | null {
  const bars = normalizeBars(barsInput)
  if (!bars.length) return null
  const metric = vwapForBars(bars, latestPrice)
  if (metric.value == null) return null
  const sigma = weightedStdDevForBars(bars, metric.value)
  const rangeFallback = Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low))
  const halfRange = Math.max(0.01, sigma ?? rangeFallback * 0.25)
  return {
    value: metric.value,
    upper: price(metric.value + halfRange),
    lower: price(Math.max(0.01, metric.value - halfRange)),
    source,
  }
}

function previousCompletedPeriodZone(
  barsInput: S12Bar[],
  latestMs: number,
  latestPrice: number,
  period: 'day' | 'week' | 'month' | 'quarter' | 'year',
  source: S12VwapZone['source'],
): S12VwapZone | null {
  const currentKey = twPeriodKey(latestMs, period)
  const byPeriod = new Map<string, S12Bar[]>()
  for (const bar of normalizeBars(barsInput)) {
    const key = twPeriodKey(bar.startMs, period)
    if (key >= currentKey) continue
    const bucket = byPeriod.get(key) ?? []
    bucket.push(bar)
    byPeriod.set(key, bucket)
  }
  const previousKey = [...byPeriod.keys()].sort().pop()
  return previousKey ? vwapZoneForBars(byPeriod.get(previousKey) ?? [], latestPrice, source) : null
}

function vwapZoneFromPreviousBar(
  barsInput: S12Bar[],
  latestPrice: number,
  source: S12VwapZone['source'],
): S12VwapZone | null {
  const bars = normalizeBars(barsInput)
  if (bars.length < 2) return null
  const previous = bars[bars.length - 2]
  const metric = vwapForBars([previous], latestPrice)
  if (metric.value == null) return null
  const halfRange = Math.max(0.01, (previous.high - previous.low) * 0.25)
  return {
    value: metric.value,
    upper: price(metric.value + halfRange),
    lower: price(Math.max(0.01, metric.value - halfRange)),
    source,
  }
}

function nearestVwapTargets(
  latestPrice: number,
  metrics: Array<{ value: number | null; source: S12VwapTarget['source'] }>,
  zones: Array<S12VwapZone | null>,
): { nearestAbove: S12VwapTarget | null; nearestBelow: S12VwapTarget | null } {
  const targets = [
    ...metrics.map((item) => item.value == null ? null : { price: item.value, source: item.source }),
    ...zones.flatMap((zone) => zone == null
      ? []
      : [
        zone.upper == null ? null : { price: zone.upper, source: zone.source },
        zone.lower == null ? null : { price: zone.lower, source: zone.source },
        zone.value == null ? null : { price: zone.value, source: zone.source },
      ]),
  ].filter((item): item is { price: number; source: S12VwapTarget['source'] } => item != null && item.price > 0)
  const above = targets
    .filter((item) => item.price > latestPrice)
    .sort((a, b) => a.price - b.price)[0] ?? null
  const below = targets
    .filter((item) => item.price < latestPrice)
    .sort((a, b) => b.price - a.price)[0] ?? null
  return {
    nearestAbove: above
      ? { ...above, distancePct: round((above.price - latestPrice) / latestPrice, 4) }
      : null,
    nearestBelow: below
      ? { ...below, distancePct: round((latestPrice - below.price) / latestPrice, 4) }
      : null,
  }
}

function buildVwapContext(
  bars15m: S12Bar[],
  policy: S12TimingPolicy,
  higher: { bars1h?: S12Bar[]; bars4h?: S12Bar[]; bars1d?: S12Bar[] } = {},
): S12StructureQuality['vwapContext'] {
  const bars = normalizeBars(bars15m)
  if (!bars.length) return emptyVwapContext()
  const latest = bars[bars.length - 1]
  const session = vwapForBars(bars, latest.close)
  const h1 = vwapForBars(higher.bars1h ?? [], latest.close)
  const session60 = vwapForBars(higher.bars4h ?? [], latest.close)
  const h4 = session60
  const dailyBars = normalizeBars(higher.bars1d ?? [])
  const dailySourceBars = dailyBars.length ? dailyBars : bars
  const daily = vwapForBars(dailySourceBars, latest.close)
  const anchored = {
    day: vwapForBars(sameCurrentPeriodBars(bars, latest.startMs, 'day'), latest.close),
    week: vwapForBars(sameCurrentPeriodBars(dailySourceBars, latest.startMs, 'week'), latest.close),
    month: vwapForBars(sameCurrentPeriodBars(dailySourceBars, latest.startMs, 'month'), latest.close),
    quarter: vwapForBars(sameCurrentPeriodBars(dailySourceBars, latest.startMs, 'quarter'), latest.close),
    year: vwapForBars(sameCurrentPeriodBars(dailySourceBars, latest.startMs, 'year'), latest.close),
  }
  const rolling15m = {
    bars7: vwapForBars(bars.slice(-7), latest.close),
    bars30: vwapForBars(bars.slice(-30), latest.close),
    bars90: vwapForBars(bars.slice(-90), latest.close),
  }
  const rollingDays = {
    days7: vwapForBars(rollingDayBars(dailySourceBars, latest.startMs, 7), latest.close),
    days30: vwapForBars(rollingDayBars(dailySourceBars, latest.startMs, 30), latest.close),
    days90: vwapForBars(rollingDayBars(dailySourceBars, latest.startMs, 90), latest.close),
    days365: vwapForBars(rollingDayBars(dailySourceBars, latest.startMs, 365), latest.close),
  }
  const previousZones = {
    h1: vwapZoneFromPreviousBar(higher.bars1h ?? [], latest.close, 'previous_h1_vwap'),
    h4: vwapZoneFromPreviousBar(higher.bars4h ?? [], latest.close, 'previous_h4_vwap'),
    daily: vwapZoneFromPreviousBar(dailySourceBars, latest.close, 'previous_daily_vwap'),
  }
  const previousPeriodZones = {
    day: previousCompletedPeriodZone(dailySourceBars, latest.startMs, latest.close, 'day', 'previous_day_vwap'),
    week: previousCompletedPeriodZone(dailySourceBars, latest.startMs, latest.close, 'week', 'previous_week_vwap'),
    month: previousCompletedPeriodZone(dailySourceBars, latest.startMs, latest.close, 'month', 'previous_month_vwap'),
    quarter: previousCompletedPeriodZone(dailySourceBars, latest.startMs, latest.close, 'quarter', 'previous_quarter_vwap'),
    year: previousCompletedPeriodZone(dailySourceBars, latest.startMs, latest.close, 'year', 'previous_year_vwap'),
  }
  const ibBars = bars.slice(0, Math.min(4, bars.length))
  const ibHigh = ibBars.length ? Math.max(...ibBars.map((bar) => bar.high)) : null
  const ibLow = ibBars.length ? Math.min(...ibBars.map((bar) => bar.low)) : null
  const initialBalanceState =
    ibHigh == null || ibLow == null
      ? 'unavailable'
      : latest.close > ibHigh
        ? 'above'
        : latest.close < ibLow
          ? 'below'
          : 'inside'
  const stackInputs = [
    session,
    h1,
    h4,
    daily,
    anchored.day,
    anchored.week,
    anchored.month,
    anchored.quarter,
    anchored.year,
    rollingDays.days7,
    rollingDays.days30,
    rollingDays.days90,
    rollingDays.days365,
  ].filter((metric) => metric.value != null)
  const aboveCount = stackInputs.filter((metric) => metric.state === 'above').length
  const belowCount = stackInputs.filter((metric) => metric.state === 'below').length
  const values = stackInputs.map((metric) => metric.value).filter((value): value is number => value != null)
  const confluenceWidthPct = values.length >= 2 && latest.close > 0
    ? round((Math.max(...values) - Math.min(...values)) / latest.close, 4)
    : null
  const nearest = nearestVwapTargets(
    latest.close,
    [
      { value: session.value, source: 'session_vwap' },
      { value: h1.value, source: 'h1_vwap' },
      { value: h4.value, source: 'h4_vwap' },
      { value: daily.value, source: 'daily_vwap' },
      { value: anchored.day.value, source: 'anchored_day_vwap' },
      { value: anchored.week.value, source: 'anchored_week_vwap' },
      { value: anchored.month.value, source: 'anchored_month_vwap' },
      { value: anchored.quarter.value, source: 'anchored_quarter_vwap' },
      { value: anchored.year.value, source: 'anchored_year_vwap' },
      { value: rolling15m.bars7.value, source: 'rolling15m_7' },
      { value: rolling15m.bars30.value, source: 'rolling15m_30' },
      { value: rolling15m.bars90.value, source: 'rolling15m_90' },
      { value: rollingDays.days7.value, source: 'rolling7d_vwap' },
      { value: rollingDays.days30.value, source: 'rolling30d_vwap' },
      { value: rollingDays.days90.value, source: 'rolling90d_vwap' },
      { value: rollingDays.days365.value, source: 'rolling365d_vwap' },
    ],
    [
      previousZones.h1,
      previousZones.h4,
      previousZones.daily,
      previousPeriodZones.day,
      previousPeriodZones.week,
      previousPeriodZones.month,
      previousPeriodZones.quarter,
      previousPeriodZones.year,
    ],
  )
  return {
    schemaVersion: 's12_vwap_context_v1',
    session,
    session60,
    h1,
    h4,
    daily,
    anchored,
    rolling15m,
    rollingDays,
    previousZones,
    previousPeriodZones,
    initialBalance: {
      high: price(ibHigh),
      low: price(ibLow),
      state: initialBalanceState,
      bars: ibBars.length,
    },
    stackState: stackInputs.length < 2
      ? 'unavailable'
      : aboveCount === stackInputs.length
        ? 'bullish_stack'
        : belowCount === stackInputs.length
          ? 'bearish_stack'
          : 'mixed',
    confluenceWidthPct,
    nearestAbove: nearest.nearestAbove,
    nearestBelow: nearest.nearestBelow,
  }
}

function buildStructureQuality(
  bars15m: S12Bar[],
  policy: S12TimingPolicy = DEFAULT_S12_TIMING_POLICY,
  higher: { bars1h?: S12Bar[]; bars4h?: S12Bar[]; bars1d?: S12Bar[] } = {},
): S12StructureQuality {
  const bars = normalizeBars(bars15m)
  if (!bars.length) return emptyQuality()
  const latest = bars[bars.length - 1]
  const vwapContext = buildVwapContext(bars, policy, higher)
  const totalVolume = bars.reduce((sum, bar) => sum + Math.max(0, Number(bar.volume ?? 0)), 0)
  const weightedValue = bars.reduce((sum, bar) => sum + Math.max(0, Number(bar.volume ?? 0)) * bar.close, 0)
  const vwap = totalVolume > 0
    ? weightedValue / totalVolume
    : bars.reduce((sum, bar) => sum + bar.close, 0) / bars.length
  const priceVsVwapPct = vwap > 0 ? (latest.close - vwap) / vwap : null
  const vwapState =
    priceVsVwapPct == null
      ? 'unavailable'
      : priceVsVwapPct > 0.001
        ? 'above'
        : priceVsVwapPct < -0.001
          ? 'below'
          : 'flat'
  const prior = bars.slice(Math.max(0, bars.length - policy.rvolLookbackBars - 1), -1)
  const priorVolumes = prior.map((bar) => Math.max(0, Number(bar.volume ?? 0))).filter((value) => value > 0)
  const avgVolume = priorVolumes.length
    ? priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length
    : null
  const latestVolume = Math.max(0, Number(latest.volume ?? 0))
  const rvol = avgVolume != null && avgVolume > 0 ? latestVolume / avgVolume : null
  const rvolState =
    rvol == null
      ? 'unavailable'
      : rvol >= 1.5
        ? 'strong_participation'
        : rvol >= 1.2
          ? 'participating'
          : 'thin'
  const notes = [
    vwapState === 'above' ? 'price_above_vwap' : null,
    vwapState === 'below' ? 'price_below_vwap' : null,
    vwapContext.stackState === 'bullish_stack' ? 'vwap_bullish_stack' : null,
    vwapContext.stackState === 'bearish_stack' ? 'vwap_bearish_stack' : null,
    vwapContext.initialBalance.state === 'above' ? 'ib_breakout_above' : null,
    vwapContext.initialBalance.state === 'below' ? 'ib_breakdown_below' : null,
    rvolState === 'strong_participation' ? 'rvol_strong_ge_1_5' : null,
    rvolState === 'participating' ? 'rvol_participating_ge_1_2' : null,
    rvolState === 'thin' ? 'rvol_below_1_2' : null,
  ].filter((note): note is string => note != null)
  return {
    vwap: {
      value: price(vwap),
      priceVsVwapPct: priceVsVwapPct == null ? null : round(priceVsVwapPct, 4),
      state: vwapState,
    },
    vwapContext,
    rvol: {
      value: rvol == null ? null : round(rvol, 4),
      state: rvolState,
      lookbackBars: priorVolumes.length,
    },
    notes,
  }
}

function channelDirection(barsInput: S12Bar[]): 'long' | 'short' | 'neutral' | 'unavailable' {
  const bars = normalizeBars(barsInput)
  if (bars.length < 2) return 'unavailable'
  const first = bars[Math.max(0, bars.length - 4)]
  const latest = bars[bars.length - 1]
  const atr = averageTrueRange(bars, Math.min(14, bars.length)) ?? Math.max(0.01, latest.high - latest.low)
  const closeSlope = latest.close - first.close
  const highSlope = latest.high - first.high
  const lowSlope = latest.low - first.low
  if (closeSlope > atr * 0.18 && highSlope >= 0 && lowSlope >= -atr * 0.2) return 'long'
  if (closeSlope < -atr * 0.18 && lowSlope <= 0 && highSlope <= atr * 0.2) return 'short'
  return 'neutral'
}

function detectEqualHighLow15m(barsInput: S12Bar[], policy: S12TimingPolicy): {
  eqh: boolean
  eql: boolean
  eqhPrice: number | null
  eqlPrice: number | null
  idmPrice: number | null
} {
  const bars = normalizeBars(barsInput).slice(-Math.max(6, policy.swingLookbackBars * 3))
  if (bars.length < 4) return { eqh: false, eql: false, eqhPrice: null, eqlPrice: null, idmPrice: null }
  const atr = averageTrueRange(bars, Math.min(policy.atr15mBars, bars.length)) ?? Math.max(0.01, bars[bars.length - 1].high - bars[bars.length - 1].low)
  const tolerance = Math.max(0.01, atr * 0.08)
  let eqhPrice: number | null = null
  let eqlPrice: number | null = null
  for (let i = 0; i < bars.length; i += 1) {
    for (let j = i + 2; j < bars.length; j += 1) {
      if (eqhPrice == null && Math.abs(bars[i].high - bars[j].high) <= tolerance) eqhPrice = price(Math.max(bars[i].high, bars[j].high))
      if (eqlPrice == null && Math.abs(bars[i].low - bars[j].low) <= tolerance) eqlPrice = price(Math.min(bars[i].low, bars[j].low))
      if (eqhPrice != null && eqlPrice != null) break
    }
    if (eqhPrice != null && eqlPrice != null) break
  }
  const swingHigh = Math.max(...bars.map((bar) => bar.high))
  const swingLow = Math.min(...bars.map((bar) => bar.low))
  return {
    eqh: eqhPrice != null,
    eql: eqlPrice != null,
    eqhPrice,
    eqlPrice,
    idmPrice: price((swingHigh + swingLow) / 2),
  }
}

function zoneLifecycleDiagnostics(params: {
  demandZone1h: S12IntradayZone | null
  supplyZone1h: S12IntradayZone | null
  bars15m: S12Bar[]
  bars1h: S12Bar[]
  bars4h: S12Bar[]
  bars1d: S12Bar[]
  policy: S12TimingPolicy
}): S12RuntimeBarDiagnostics {
  const equalLevels = detectEqualHighLow15m(params.bars15m, params.policy)
  const zoneOverlap = params.demandZone1h != null && params.supplyZone1h != null && zonesOverlap(params.demandZone1h, params.supplyZone1h)
  const roleFlipDemand = params.demandZone1h?.type === 'support'
  const roleFlipSupply = params.supplyZone1h?.type === 'resistance'
  const sessionAcceptance = resolveSessionAcceptance(params.bars4h, params.policy)
  return {
    pine_v7_parity_contract: 'tp1_tp4_auto_trailing_stop_source_role_flip_channel_idm_eqh_eql',
    zone_overlap_detected: zoneOverlap ? 'true' : 'false',
    zone_overlap_priority: zoneOverlap ? 'order_block_over_fvg_when_cross_type_overlap' : null,
    role_flip_detected: roleFlipDemand || roleFlipSupply ? 'true' : 'false',
    role_flip_side: roleFlipDemand && roleFlipSupply ? 'both' : roleFlipDemand ? 'demand' : roleFlipSupply ? 'supply' : null,
    channel_1h_direction: channelDirection(params.bars1h),
    channel_session_60m_direction: sessionAcceptance.channelDirection,
    session_60m_bias_method: 'whole_session_acceptance_v2',
    session_60m_locked_at_high: sessionAcceptance.lockedAtSessionHigh ? 'true' : 'false',
    session_60m_locked_at_low: sessionAcceptance.lockedAtSessionLow ? 'true' : 'false',
    session_60m_close_position: sessionAcceptance.sessionClosePosition,
    session_60m_latest_close_position: sessionAcceptance.latestClosePosition,
    session_60m_move_atr: sessionAcceptance.sessionMoveAtr,
    channel_1d_direction: channelDirection(params.bars1d),
    idm_price: equalLevels.idmPrice,
    eqh_detected: equalLevels.eqh ? 'true' : 'false',
    eqh_price: equalLevels.eqhPrice,
    eql_detected: equalLevels.eql ? 'true' : 'false',
    eql_price: equalLevels.eqlPrice,
  }
}

function emptyBearishDefense(
  state: S12BearishDefense['state'] = 'no_supply_zone',
  reason = 's12_bearish_defense_not_ready',
  detail: Record<string, unknown> = {},
  supplyZone1h: S12IntradayZone | null = null,
): S12BearishDefense {
  return {
    state,
    ready: state === 'bearish_defense_ready',
    action: state === 'bearish_defense_ready' ? 'NO_BUY' : 'none',
    reason,
    detail: detailText({ state, reason, ...detail }),
    supplyZone1h,
    sequence: {},
  }
}

function emptyAssessment(
  input: S12IntradayInput,
  state: S12IntradayState,
  reason: string,
  detail: Record<string, unknown>,
  completedBars: S12IntradayAssessment['completedBars'],
): S12IntradayAssessment {
  const h4Source = input.h4Source ?? (completedBars.h4 > 0 ? 'current_session' : 'unavailable')
  const sessionContextSource: NonNullable<S12IntradayAssessment['sessionContextSource']> = input.sessionContextSource ?? (
    h4Source === 'previous_trading_day_fallback'
      ? 'previous_session_60m'
      : (completedBars.session60 ?? completedBars.h4) > 0
        ? 'current_session_60m'
        : 'unavailable'
  )
  const barDiagnostics = input.barDiagnostics ?? {}
  const policy = inputTimingPolicy(input)
  const maturity = maturitySnapshot(state)
  return {
    version: 's12_intraday_structure_v1',
    engineVersion: 's12_smcvwap_tw_equity_v2',
    symbol: input.symbol,
    direction: 'long',
    state,
    entryState: entryStateFor(state),
    ready: false,
    invalidated: state === 'invalidated',
    reason,
    detail: detailText({
      state,
      reason,
      session_context_source: sessionContextSource,
      h4_source: h4Source,
      h4_reference_date: input.h4ReferenceDate ?? null,
      h4_reference_close: price(input.h4ReferenceClose),
      h4_fallback_bias_mode: h4Source === 'previous_trading_day_fallback' ? 'context_only' : null,
      ...timingPolicyDetail(policy),
      ...barDiagnostics,
      ...detail,
    }),
    setupId: null,
    completedBars: {
      ...completedBars,
      session60: completedBars.session60 ?? completedBars.h4,
      h4: completedBars.session60 ?? completedBars.h4,
    },
    sessionContextSource,
    h4Source,
    h4ReferenceDate: input.h4ReferenceDate ?? null,
    h4ReferenceClose: price(input.h4ReferenceClose),
    barDiagnostics,
    coverage: completedBars.h4 > 0 || completedBars.h1 > 0 || completedBars.m15 > 0 ? 'partial' : 'none',
    bias4h: { direction: 'neutral', confidence: 'none', channelAlign: false },
    biasSession60: { direction: 'neutral', confidence: 'none', channelAlign: false },
    bias1h: { direction: 'neutral', confidence: 'none', channelAlign: false },
    demandZone1h: null,
    supplyZone1h: null,
    bearishDefense: emptyBearishDefense(),
    defensiveAction: 'none',
    quality: emptyQuality(),
    exitPlan: emptyExitPlan(),
    sequence: {},
    execution: {},
    maturity,
  }
}

interface S12SessionAcceptance {
  direction: S12HtfBias['direction']
  confidence: S12HtfBias['confidence']
  channelAlign: boolean
  channelDirection: 'long' | 'short' | 'neutral' | 'unavailable'
  lockedAtSessionHigh: boolean
  lockedAtSessionLow: boolean
  sessionClosePosition: number | null
  latestClosePosition: number | null
  sessionMoveAtr: number | null
}

function resolveSessionAcceptance(barsInput: S12Bar[], policy: S12TimingPolicy): S12SessionAcceptance {
  const normalized = normalizeBars(barsInput)
  if (normalized.length === 0) {
    return {
      direction: 'neutral',
      confidence: 'none',
      channelAlign: false,
      channelDirection: 'unavailable',
      lockedAtSessionHigh: false,
      lockedAtSessionLow: false,
      sessionClosePosition: null,
      latestClosePosition: null,
      sessionMoveAtr: null,
    }
  }
  const latestSessionDate = new Date(
    normalized[normalized.length - 1].startMs + TW_OFFSET_MS,
  ).toISOString().slice(0, 10)
  const bars = normalized.filter((bar) => (
    new Date(bar.startMs + TW_OFFSET_MS).toISOString().slice(0, 10) === latestSessionDate
  ))

  const first = bars[0]
  const latest = bars[bars.length - 1]
  const previous = bars[bars.length - 2] ?? null
  const atr = averageTrueRange(bars, Math.min(14, bars.length))
    ?? Math.max(0.0001, latest.high - latest.low)
  const sessionHigh = Math.max(...bars.map((bar) => bar.high))
  const sessionLow = Math.min(...bars.map((bar) => bar.low))
  const sessionRange = Math.max(0.0001, sessionHigh - sessionLow)
  const tolerance = Math.max(
    0.0001,
    atr * policy.sessionLockToleranceAtr,
    Math.abs(latest.close) * policy.sessionLockTolerancePct,
  )
  const lastBars = bars.slice(-Math.min(policy.sessionLockMinBars, bars.length))
  const sessionMoveAtr = atr > 0 ? (latest.close - first.open) / atr : 0
  const lockedAtSessionHigh = bars.length >= policy.sessionLockMinBars
    && sessionMoveAtr >= policy.sessionAcceptanceMinMoveAtr
    && lastBars.every((bar) => (
      bar.high - bar.low <= tolerance
      && Math.abs(bar.close - sessionHigh) <= tolerance
    ))
  const lockedAtSessionLow = bars.length >= policy.sessionLockMinBars
    && sessionMoveAtr <= -policy.sessionAcceptanceMinMoveAtr
    && lastBars.every((bar) => (
      bar.high - bar.low <= tolerance
      && Math.abs(bar.close - sessionLow) <= tolerance
    ))
  const latestRange = latest.high - latest.low
  const latestClosePosition = latestRange > tolerance
    ? (latest.close - latest.low) / latestRange
    : lockedAtSessionHigh
      ? 1
      : lockedAtSessionLow
        ? 0
        : 0.5
  const sessionClosePosition = (latest.close - sessionLow) / sessionRange
  const bullishCandle = latest.close > latest.open && latestClosePosition >= 0.55
  const confirmedStructure = previous != null && latest.close > previous.close && latest.low >= previous.low * 0.995
  const bearishCandle = latest.close < latest.open && latestClosePosition <= 0.45
  const bearishStructure = previous != null && latest.close < previous.close && latest.high <= previous.high * 1.005
  const channel = channelDirection(bars)
  const wholeSessionLong = sessionMoveAtr >= policy.sessionAcceptanceMinMoveAtr
    && sessionClosePosition >= policy.sessionAcceptanceMinClosePosition
    && channel !== 'short'
  const wholeSessionShort = sessionMoveAtr <= -policy.sessionAcceptanceMinMoveAtr
    && sessionClosePosition <= 1 - policy.sessionAcceptanceMinClosePosition
    && channel !== 'long'
  const direction: S12HtfBias['direction'] = (
    (bullishCandle && (confirmedStructure || previous == null))
    || wholeSessionLong
    || lockedAtSessionHigh
  )
    ? 'long'
    : (
        (bearishCandle && (bearishStructure || previous == null))
        || wholeSessionShort
        || lockedAtSessionLow
      )
      ? 'short'
      : 'neutral'

  return {
    direction,
    confidence: bars.length >= 2 ? 'confirmed' : 'provisional',
    channelAlign: direction === 'long' && channel === 'long',
    channelDirection: channel,
    lockedAtSessionHigh,
    lockedAtSessionLow,
    sessionClosePosition: round(sessionClosePosition, 4),
    latestClosePosition: round(latestClosePosition, 4),
    sessionMoveAtr: round(sessionMoveAtr, 4),
  }
}

function resolve4hBias(bars4h: S12Bar[], policy: S12TimingPolicy): S12Bias4h {
  const acceptance = resolveSessionAcceptance(bars4h, policy)
  return {
    direction: acceptance.direction,
    confidence: acceptance.confidence,
    channelAlign: acceptance.channelAlign,
  }
}

function resolve1hBias(bars1h: S12Bar[], policy: S12TimingPolicy): S12HtfBias {
  return resolve4hBias(bars1h, policy)
}

function latestBullishFvg1h(bars: S12Bar[], atr: number, policy: S12TimingPolicy): S12IntradayZone | null {
  for (let i = bars.length - 1; i >= 2; i -= 1) {
    const left = bars[i - 2]
    const current = bars[i]
    const gap = current.low - left.high
    if (gap < Math.max(0.01, atr * policy.minFvgAtr)) continue
    return {
      type: 'bullish_fvg',
      low: round(left.high, 4),
      high: round(current.low, 4),
      createdMs: current.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function latestBearishFvg1h(bars: S12Bar[], atr: number, policy: S12TimingPolicy): S12IntradayZone | null {
  for (let i = bars.length - 1; i >= 2; i -= 1) {
    const left = bars[i - 2]
    const current = bars[i]
    const gap = left.low - current.high
    if (gap < Math.max(0.01, atr * policy.minFvgAtr)) continue
    return {
      type: 'bearish_fvg',
      low: round(current.high, 4),
      high: round(left.low, 4),
      createdMs: current.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function zonesOverlap(a: S12IntradayZone, b: S12IntradayZone): boolean {
  return a.low <= b.high && b.low <= a.high
}

function latestBullishOrderBlock1h(bars: S12Bar[], atr: number, policy: S12TimingPolicy): S12IntradayZone | null {
  for (let i = bars.length - 1; i >= Math.max(1, bars.length - policy.obLookbackBars); i -= 1) {
    const previous = bars[i - 1]
    const current = bars[i]
    const body = Math.abs(current.close - current.open)
    const bullishDisplacement = current.close > current.open && current.close > previous.high && body >= atr * 0.18
    if (!bullishDisplacement) continue
    const ob = lastBearishBar(bars, Math.max(0, i - policy.obLookbackBars), i - 1) ?? previous
    const low = Math.min(ob.low, current.low)
    const high = Math.max(low + atr * policy.srZoneAtr, Math.min(ob.high, current.close))
    return {
      type: 'bullish_order_block',
      low: round(low, 4),
      high: round(Math.max(high, low + 0.01), 4),
      createdMs: current.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function latestBearishOrderBlock1h(bars: S12Bar[], atr: number, policy: S12TimingPolicy): S12IntradayZone | null {
  for (let i = bars.length - 1; i >= Math.max(1, bars.length - policy.obLookbackBars); i -= 1) {
    const previous = bars[i - 1]
    const current = bars[i]
    const body = Math.abs(current.close - current.open)
    const bearishDisplacement = current.close < current.open && current.close < previous.low && body >= atr * 0.18
    if (!bearishDisplacement) continue
    const ob = lastBullishBar(bars, Math.max(0, i - policy.obLookbackBars), i - 1) ?? previous
    const high = Math.max(ob.high, current.high)
    const low = Math.min(high - atr * policy.srZoneAtr, Math.max(ob.low, current.close))
    return {
      type: 'bearish_order_block',
      low: round(Math.min(low, high - 0.01), 4),
      high: round(high, 4),
      createdMs: current.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function latestRoleFlipDemandZone1h(bars: S12Bar[], atr: number, policy: S12TimingPolicy): S12IntradayZone | null {
  const buffer = atr * policy.srBreakBufferAtr
  for (let i = bars.length - 1 - policy.srBreakConfirmBars; i >= policy.srPivotLen; i -= 1) {
    const pivot = bars[i]
    const leftHigh = highBetween(bars, i - policy.srPivotLen, i)
    const rightHigh = highBetween(bars, i + 1, i + 1 + policy.srPivotLen)
    if (leftHigh == null || rightHigh == null || pivot.high < Math.max(leftHigh, rightHigh)) continue
    const confirms = bars
      .slice(i + 1, Math.min(bars.length, i + 1 + policy.srBreakConfirmBars))
      .filter((bar) => bar.close > pivot.high + buffer)
    if (confirms.length < policy.srBreakConfirmBars) continue
    const low = Math.max(pivot.low, pivot.high - atr * Math.max(policy.srZoneAtr, 0.35))
    return {
      type: 'support',
      low: round(Math.min(low, pivot.high - 0.01), 4),
      high: round(pivot.high, 4),
      createdMs: confirms[confirms.length - 1].startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function latestRoleFlipSupplyZone1h(bars: S12Bar[], atr: number, policy: S12TimingPolicy): S12IntradayZone | null {
  const buffer = atr * policy.srBreakBufferAtr
  for (let i = bars.length - 1 - policy.srBreakConfirmBars; i >= policy.srPivotLen; i -= 1) {
    const pivot = bars[i]
    const leftLow = lowBetween(bars, i - policy.srPivotLen, i)
    const rightLow = lowBetween(bars, i + 1, i + 1 + policy.srPivotLen)
    if (leftLow == null || rightLow == null || pivot.low > Math.min(leftLow, rightLow)) continue
    const confirms = bars
      .slice(i + 1, Math.min(bars.length, i + 1 + policy.srBreakConfirmBars))
      .filter((bar) => bar.close < pivot.low - buffer)
    if (confirms.length < policy.srBreakConfirmBars) continue
    const high = Math.min(pivot.high, pivot.low + atr * Math.max(policy.srZoneAtr, 0.35))
    return {
      type: 'resistance',
      low: round(pivot.low, 4),
      high: round(Math.max(high, pivot.low + 0.01), 4),
      createdMs: confirms[confirms.length - 1].startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function findDemandZone1h(bars1h: S12Bar[], policy: S12TimingPolicy = DEFAULT_S12_TIMING_POLICY): S12IntradayZone | null {
  const bars = normalizeBars(bars1h)
  if (!bars.length) return null
  const atr = averageTrueRange(bars, policy.zoneAtrBars) ?? Math.max(0.01, bars[bars.length - 1].high - bars[bars.length - 1].low)
  const fvg = latestBullishFvg1h(bars, atr, policy)
  const ob = latestBullishOrderBlock1h(bars, atr, policy)
  if (ob && fvg && zonesOverlap(ob, fvg)) return ob
  if (fvg) return fvg
  if (ob) return ob
  const roleFlip = latestRoleFlipDemandZone1h(bars, atr, policy)
  if (roleFlip) return roleFlip
  for (let i = bars.length - 1 - policy.srPivotLen; i >= policy.srPivotLen; i -= 1) {
    const bar = bars[i]
    const leftLow = lowBetween(bars, i - policy.srPivotLen, i)
    const rightLow = lowBetween(bars, i + 1, i + 1 + policy.srPivotLen)
    if (leftLow == null || rightLow == null || bar.low > Math.min(leftLow, rightLow)) continue
    const high = Math.min(bar.high, bar.low + atr * policy.srZoneAtr)
    return {
      type: 'pivot_demand',
      low: round(bar.low, 4),
      high: round(Math.max(high, bar.low + 0.01), 4),
      createdMs: bar.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - policy.maxVisibleZones); i -= 1) {
    const bar = bars[i]
    const closePosition = (bar.close - bar.low) / Math.max(0.0001, bar.high - bar.low)
    if (bar.close <= bar.open || closePosition < 0.5) continue
    const high = Math.min(bar.high, bar.low + atr * Math.max(policy.srZoneAtr, 0.55))
    return {
      type: 'support',
      low: round(bar.low, 4),
      high: round(Math.max(high, bar.low + 0.01), 4),
      createdMs: bar.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function findSupplyZone1h(bars1h: S12Bar[], policy: S12TimingPolicy = DEFAULT_S12_TIMING_POLICY): S12IntradayZone | null {
  const bars = normalizeBars(bars1h)
  if (!bars.length) return null
  const atr = averageTrueRange(bars, policy.zoneAtrBars) ?? Math.max(0.01, bars[bars.length - 1].high - bars[bars.length - 1].low)
  const fvg = latestBearishFvg1h(bars, atr, policy)
  const ob = latestBearishOrderBlock1h(bars, atr, policy)
  if (ob && fvg && zonesOverlap(ob, fvg)) return ob
  if (fvg) return fvg
  if (ob) return ob
  const roleFlip = latestRoleFlipSupplyZone1h(bars, atr, policy)
  if (roleFlip) return roleFlip
  for (let i = bars.length - 1 - policy.srPivotLen; i >= policy.srPivotLen; i -= 1) {
    const bar = bars[i]
    const leftHigh = highBetween(bars, i - policy.srPivotLen, i)
    const rightHigh = highBetween(bars, i + 1, i + 1 + policy.srPivotLen)
    if (leftHigh == null || rightHigh == null || bar.high < Math.max(leftHigh, rightHigh)) continue
    const low = Math.max(bar.low, bar.high - atr * policy.srZoneAtr)
    return {
      type: 'pivot_supply',
      low: round(Math.min(low, bar.high - 0.01), 4),
      high: round(bar.high, 4),
      createdMs: bar.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - policy.maxVisibleZones); i -= 1) {
    const bar = bars[i]
    const closePosition = (bar.close - bar.low) / Math.max(0.0001, bar.high - bar.low)
    if (bar.close >= bar.open || closePosition > 0.5) continue
    const low = Math.max(bar.low, bar.high - atr * Math.max(policy.srZoneAtr, 0.55))
    return {
      type: 'resistance',
      low: round(Math.min(low, bar.high - 0.01), 4),
      high: round(bar.high, 4),
      createdMs: bar.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  return null
}

function volumeExpansionRatio(bars: S12Bar[], lookback = 4): number | null {
  if (bars.length < 2) return null
  const latest = Math.max(0, Number(bars[bars.length - 1].volume ?? 0))
  const previous = bars
    .slice(Math.max(0, bars.length - 1 - lookback), bars.length - 1)
    .map((bar) => Math.max(0, Number(bar.volume ?? 0)))
    .filter((value) => value > 0)
  if (!previous.length || latest <= 0) return null
  const avg = previous.reduce((sum, value) => sum + value, 0) / previous.length
  return avg > 0 ? round(latest / avg, 4) : null
}

function buildEquityMutationZone(params: {
  bars15m: S12Bar[]
  entryPrice: number
  atr15m: number
  policy: S12TimingPolicy
}): { zone: S12IntradayZone | null; stopPlan: S12PositionStopPlan | null } {
  const stopPlan = buildS12LongPositionStopPlan({
    bars15m: params.bars15m,
    entryPrice: params.entryPrice,
    referencePrice: params.entryPrice,
    policy: params.policy,
    stopSource: 'adaptive',
  })
  if (stopPlan) {
    return {
      stopPlan,
      zone: {
        type: stopPlan.source === '15m_recent_fvg'
          ? 'bullish_fvg'
          : stopPlan.source === '15m_order_block'
            ? 'bullish_order_block'
            : 'support',
        low: stopPlan.zoneLow,
        high: Math.min(params.entryPrice - 0.01, Math.max(stopPlan.zoneHigh, stopPlan.price)),
        createdMs: params.bars15m[params.bars15m.length - 1]?.startMs ?? Date.now(),
        ageBars: 0,
      },
    }
  }

  const recent = params.bars15m.slice(Math.max(0, params.bars15m.length - 5))
  const protectedLow = recent
    .map((bar) => bar.low)
    .filter((value) => Number.isFinite(value) && value > 0 && value < params.entryPrice)
    .sort((a, b) => b - a)[0] ?? null
  if (protectedLow == null) return { zone: null, stopPlan: null }
  const stop = price(protectedLow - params.atr15m * params.policy.stopStructureBufferAtr)
  if (stop == null || stop <= 0 || stop >= params.entryPrice) return { zone: null, stopPlan: null }
  const zoneHigh = price(Math.min(params.entryPrice - 0.01, protectedLow + params.atr15m * 0.35))
  if (zoneHigh == null || zoneHigh <= stop) return { zone: null, stopPlan: null }
  return {
    zone: {
      type: 'support',
      low: stop,
      high: zoneHigh,
      createdMs: recent[recent.length - 1]?.startMs ?? Date.now(),
      ageBars: 0,
    },
    stopPlan: {
      price: stop,
      source: '15m_protected_low',
      method: '15m_protected_low',
      zoneLow: stop,
      zoneHigh,
      noAtrBuffer: true,
    },
  }
}

function buildEquityMutationContext(params: {
  bars15m: S12Bar[]
  bias4h: S12HtfBias
  bias1h: S12HtfBias
  quality: S12StructureQuality
  policy: S12TimingPolicy
}): S12EquityMutationContext {
  const bars = normalizeBars(params.bars15m)
  const latest = bars[bars.length - 1]
  const previous = bars[bars.length - 2] ?? null
  const atr15m = averageTrueRange(bars, params.policy.atr15mBars) ?? (latest ? Math.max(0.01, latest.high - latest.low) : null)
  if (!latest || !atr15m || atr15m <= 0) {
    return {
      active: false,
      archetype: 'unavailable',
      score: 0,
      reasons: [],
      riskHaircuts: [],
      vwapFastAcceptance: false,
      vwapFastReasons: [],
      vwapFastBlockers: [],
      vwapSlowContext: 'unavailable',
      htfHardBlock: false,
      strictBreakout: false,
      limitedTakeover: false,
      sizeMultiplier: null,
      stopRiskPct: null,
      stopRiskAtr: null,
      zone: null,
      stopPlan: null,
      entryPrice: null,
      chaseCeiling: null,
      atr15m,
    }
  }

  const priorHigh = highBetween(bars, Math.max(0, bars.length - 7), bars.length - 1)
  const priorClose = previous?.close ?? null
  const range = Math.max(0.0001, latest.high - latest.low)
  const closePosition = (latest.close - latest.low) / range
  const bodyPct = Math.abs(latest.close - latest.open) / range
  const volExpansion = volumeExpansionRatio(bars, 4)
  const fastVwapSignals = [
    params.quality.vwap.state === 'above' ? 'session_vwap_above' : null,
    params.quality.vwapContext.session.state === 'above' ? 'session_vwap_context_above' : null,
    params.quality.vwapContext.rolling15m.bars7.state === 'above' ? 'rolling15m_7_above' : null,
    params.quality.vwapContext.rolling15m.bars30.state === 'above' ? 'rolling15m_30_above' : null,
    params.quality.vwapContext.initialBalance.state === 'above' ? 'initial_balance_breakout' : null,
  ].filter((value): value is string => value != null)
  const fastVwapBlockers = [
    params.quality.vwap.state === 'below' ? 'session_vwap_below' : null,
    params.quality.vwapContext.rolling15m.bars7.state === 'below' ? 'rolling15m_7_below' : null,
    params.quality.vwapContext.initialBalance.state === 'below' ? 'initial_balance_breakdown' : null,
  ].filter((value): value is string => value != null)
  const vwapFastAcceptance = fastVwapSignals.length >= params.policy.minFastVwapSignals && fastVwapBlockers.length <= params.policy.maxFastVwapBlockers
  const slowVwapAbove = [
    params.quality.vwapContext.h1,
    params.quality.vwapContext.h4,
    params.quality.vwapContext.daily,
    params.quality.vwapContext.anchored.week,
    params.quality.vwapContext.anchored.month,
    params.quality.vwapContext.rollingDays.days7,
    params.quality.vwapContext.rollingDays.days30,
  ].filter((metric) => metric.value != null && metric.state === 'above').length
  const slowVwapTotal = [
    params.quality.vwapContext.h1,
    params.quality.vwapContext.h4,
    params.quality.vwapContext.daily,
    params.quality.vwapContext.anchored.week,
    params.quality.vwapContext.anchored.month,
    params.quality.vwapContext.rollingDays.days7,
    params.quality.vwapContext.rollingDays.days30,
  ].filter((metric) => metric.value != null).length
  const vwapSlowContext = slowVwapTotal <= 0
    ? 'unavailable'
    : slowVwapAbove >= Math.ceil(slowVwapTotal * params.policy.slowVwapSupportiveRatio)
      ? 'supportive'
      : slowVwapAbove <= Math.floor(slowVwapTotal * params.policy.slowVwapOverheadRatio)
        ? 'overhead_supply'
        : 'mixed'
  const volumeConstructive =
    params.quality.rvol.state === 'strong_participation' ||
    params.quality.rvol.state === 'participating' ||
    (volExpansion != null && volExpansion >= params.policy.volumeExpansionMin)
  const repricingBreakout = priorHigh != null && latest.close > priorHigh + atr15m * params.policy.repricingBreakoutAtr
  const reclaimBreakout = priorClose != null && priorHigh != null && priorClose <= priorHigh && latest.close > priorHigh
  const strongClose = latest.close > latest.open && closePosition >= params.policy.strongClosePosition && bodyPct >= params.policy.strongBodyPct
  const sessionAcceptance = resolveSessionAcceptance(bars, params.policy)
  const acceptedStrongClose = strongClose || sessionAcceptance.lockedAtSessionHigh
  const higherLow = previous != null && latest.low >= previous.low - atr15m * params.policy.higherLowAtrTolerance
  const htfHardBlock = params.bias4h.direction === 'short' && params.bias1h.direction === 'short'
  const riskHaircuts = [
    params.bias1h.direction === 'short' ? '1h_short_risk_haircut' : null,
    params.bias4h.direction === 'short' ? 'session_60m_short_risk_haircut' : null,
    vwapSlowContext === 'overhead_supply' ? 'slow_vwap_overhead_supply_haircut' : null,
  ].filter((value): value is string => value != null)
  const positiveReasons = [
    repricingBreakout ? '15m_repricing_breakout' : null,
    reclaimBreakout ? '15m_prior_high_reclaim' : null,
    acceptedStrongClose ? (sessionAcceptance.lockedAtSessionHigh ? 'session_high_lock_acceptance' : '15m_strong_close') : null,
    higherLow ? '15m_higher_low_acceptance' : null,
    vwapFastAcceptance ? 'vwap_fast_acceptance' : null,
    volumeConstructive ? 'volume_participation' : null,
    params.bias4h.direction !== 'short' ? 'session_60m_not_short' : null,
    params.bias1h.direction !== 'short' ? '1h_not_short' : null,
  ].filter((value): value is string => value != null)
  const score = Math.max(0, positiveReasons.length - riskHaircuts.length)
  const entryPrice = price(latest.close)
  const zoneResult = entryPrice != null
    ? buildEquityMutationZone({ bars15m: bars, entryPrice, atr15m, policy: params.policy })
    : { zone: null, stopPlan: null }
  const stopRisk =
    entryPrice != null && zoneResult.stopPlan?.price != null
      ? entryPrice - zoneResult.stopPlan.price
      : null
  const stopRiskPct =
    stopRisk != null && entryPrice != null && entryPrice > 0
      ? round(stopRisk / entryPrice, 4)
      : null
  const stopRiskAtr =
    stopRisk != null && atr15m > 0
      ? round(stopRisk / atr15m, 4)
      : null
  const tightStopRisk = Boolean(
    stopRisk != null &&
    stopRisk > 0 &&
    stopRiskPct != null &&
    stopRiskPct <= params.policy.maxStopRiskPct &&
    stopRiskAtr != null &&
    stopRiskAtr <= params.policy.maxStopRiskAtr,
  )
  const strictBreakout = Boolean(
    entryPrice != null &&
    zoneResult.zone != null &&
    zoneResult.stopPlan != null &&
    !htfHardBlock &&
    tightStopRisk &&
    vwapFastAcceptance &&
    volumeConstructive &&
    acceptedStrongClose &&
    (repricingBreakout || reclaimBreakout) &&
    score >= params.policy.strictMutationMinScore,
  )
  const supportiveSlowVwap = vwapSlowContext === 'supportive' || vwapSlowContext === 'mixed'
  const limitedTakeover = Boolean(
    entryPrice != null &&
    zoneResult.zone != null &&
    zoneResult.stopPlan != null &&
    !htfHardBlock &&
    tightStopRisk &&
    acceptedStrongClose &&
    higherLow &&
    score >= params.policy.limitedMutationMinScore &&
    (vwapFastAcceptance || supportiveSlowVwap) &&
    vwapSlowContext !== 'overhead_supply',
  )
  const active = strictBreakout || limitedTakeover
  const sizeMultiplier = active
    ? strictBreakout
      ? params.policy.strictSizeMultiplier
      : params.policy.limitedSizeMultiplier
    : null
  return {
    active,
    archetype: active
      ? strictBreakout
        ? 'equity_repricing_breakout'
        : 'equity_limited_takeover'
      : 'unavailable',
    score,
    reasons: positiveReasons,
    riskHaircuts,
    vwapFastAcceptance,
    vwapFastReasons: fastVwapSignals,
    vwapFastBlockers: fastVwapBlockers,
    vwapSlowContext,
    htfHardBlock,
    strictBreakout,
    limitedTakeover,
    sizeMultiplier,
    stopRiskPct,
    stopRiskAtr,
    zone: zoneResult.zone,
    stopPlan: zoneResult.stopPlan,
    entryPrice,
    chaseCeiling: entryPrice == null ? null : price(entryPrice + atr15m * params.policy.chaseAtrMultiplier),
    atr15m: price(atr15m),
  }
}

function buildEquityMutationExitPlan(params: {
  bars15m: S12Bar[]
  entryPrice: number
  stopPlan: S12PositionStopPlan
  supplyZone1h: S12IntradayZone | null
  bearishDefense: S12BearishDefense
  quality: S12StructureQuality
  policy: S12TimingPolicy
}): S12StructureExitPlan {
  const risk = Math.max(0.01, params.entryPrice - params.stopPlan.price)
  const priorHighs = nearestPriorHighsAbove(params.bars15m, 0, params.bars15m.length - 1, params.entryPrice)
  const priorHigh = priorHighs[0] ?? null
  const supplyLow = params.supplyZone1h?.low ?? null
  const supplyHigh = params.supplyZone1h?.high ?? null
  const supplyExit = supplyLow != null && supplyLow > params.entryPrice
    ? supplyLow
    : supplyHigh != null && supplyHigh > params.entryPrice
      ? supplyHigh
      : null
  const vwapTargets = vwapTargetCandidatesAbove(params.quality.vwapContext, params.entryPrice)
  const fallbackTp1 = price(params.entryPrice + risk)
  const fallbackMainExit = price(params.entryPrice + risk * 2)
  const fallbackTp3 = price(params.entryPrice + risk * 3)
  const fallbackTp4 = price(params.entryPrice + risk * 4)
  const tp1Vwap = priorHigh == null
    ? vwapTargets.find((candidate) => candidate.price > params.entryPrice + 0.01) ?? null
    : null
  const tp1Price = priorHigh ?? tp1Vwap?.price ?? fallbackTp1
  const mainExitCandidate = supplyExit != null
    ? { price: price(supplyExit), source: '1h_supply_zone' as const, detail: '1h_supply_zone' }
    : nextCandidateTargetAbove(vwapTargets, tp1Price ?? params.entryPrice, fallbackMainExit)
  const mainExitPrice = price(mainExitCandidate.price)
  const ladderCandidates: S12LongTargetCandidate[] = uniqueSortedTargets([
    ...priorHighs.map((value) => ({ price: value, source: '15m_previous_high' as const, detail: '15m_previous_high' })),
    ...(supplyHigh != null ? [{ price: price(supplyHigh)!, source: '1h_supply_zone' as const, detail: '1h_supply_zone_high' }] : []),
    ...vwapTargets,
  ])
  const tp3 = nextCandidateTargetAbove(ladderCandidates, mainExitPrice ?? params.entryPrice, fallbackTp3)
  const tp4 = nextCandidateTargetAbove(ladderCandidates, tp3.price ?? mainExitPrice ?? params.entryPrice, fallbackTp4)

  return {
    mode: 'structure_first_trailing_v1',
    tp1: {
      price: tp1Price,
      source: priorHigh != null
        ? '15m_previous_high'
        : tp1Vwap != null
          ? 'vwap_fair_value'
          : fallbackTp1 != null
            ? 'r_multiple_fallback'
            : 'unavailable',
      action: 'partial_take_profit',
    },
    mainExit: {
      price: mainExitPrice,
      zoneLow: price(supplyLow),
      zoneHigh: price(supplyHigh),
      source: supplyExit != null
        ? '1h_supply_zone'
        : mainExitCandidate.source === '15m_previous_high'
          ? 'tp_ladder'
          : mainExitCandidate.source,
      action: 'main_take_profit',
    },
    tp3: {
      price: tp3.price,
      source: tp3.source === '15m_previous_high' ? 'tp_ladder' : tp3.source,
      action: 'extended_take_profit',
    },
    tp4: {
      price: tp4.price,
      source: tp4.source === '15m_previous_high' ? 'tp_ladder' : tp4.source,
      action: 'extended_take_profit',
    },
    manualTp: {
      price: null,
      source: 'unavailable',
      action: 'manual_take_profit',
    },
    trailingStop: {
      initial: params.stopPlan.price,
      method: params.stopPlan.method,
      source: params.stopPlan.source,
      activation: 'after_tp1_or_reverse_choch',
    },
    reverseWarning: {
      state: params.bearishDefense.state,
      action: params.bearishDefense.ready ? 'EXIT_ON_REVERSE_BOS' : params.bearishDefense.action,
      source: 'bearish_defense_sidecar',
    },
  }
}

function completeEquityMutationAssessment(params: {
  input: S12IntradayInput
  bars15m: S12Bar[]
  completedBars: S12IntradayAssessment['completedBars']
  bias4h: S12HtfBias
  bias1h: S12HtfBias
  supplyZone1h: S12IntradayZone | null
  bearishDefense: S12BearishDefense
  quality: S12StructureQuality
  mutation: S12EquityMutationContext
  policy: S12TimingPolicy
}): S12IntradayAssessment {
  const entryPrice = params.mutation.entryPrice ?? params.bars15m[params.bars15m.length - 1]?.close
  const stopPlan = params.mutation.stopPlan
  const mutationZone = params.mutation.zone
  if (entryPrice == null || stopPlan == null || mutationZone == null) {
    return completeAssessment({
      input: params.input,
      state: 'waiting_1h_demand_zone',
      completedBars: params.completedBars,
      bias4h: params.bias4h,
      bias1h: params.bias1h,
      demandZone1h: null,
      supplyZone1h: params.supplyZone1h,
      bearishDefense: params.bearishDefense,
      quality: params.quality,
      sequence: {},
    })
  }
  const exitPlan = buildEquityMutationExitPlan({
    bars15m: params.bars15m,
    entryPrice,
    stopPlan,
    supplyZone1h: params.supplyZone1h,
    bearishDefense: params.bearishDefense,
    quality: params.quality,
    policy: params.policy,
  })
  return completeAssessment({
    input: params.input,
    state: 'limited_takeover_ready',
    reason: 's12_equity_mutation_context_ready',
    completedBars: params.completedBars,
    bias4h: params.bias4h,
    bias1h: params.bias1h,
    demandZone1h: mutationZone,
    supplyZone1h: params.supplyZone1h,
    bearishDefense: params.bearishDefense,
    quality: params.quality,
    exitPlan,
    sequence: {
      zoneTouchMs: params.bars15m[params.bars15m.length - 1]?.startMs ?? null,
      reactionMs: params.bars15m[params.bars15m.length - 1]?.startMs ?? null,
    },
    execution: {
      entryPrice,
      chaseCeiling: params.mutation.chaseCeiling,
      stopLoss: stopPlan.price,
      target1: exitPlan.tp1.price,
      target2: exitPlan.mainExit.price,
      target3: exitPlan.tp3.price,
      target4: exitPlan.tp4.price,
      atr15m: params.mutation.atr15m,
      rMultiple: params.mutation.atr15m != null && params.mutation.atr15m > 0
        ? (entryPrice - stopPlan.price) / params.mutation.atr15m
        : null,
    },
    setupId: setupKey(params.input.symbol, params.bars15m[params.bars15m.length - 1]?.startMs),
    extraDetail: {
      s12_owner: 'primary_single_owner',
      entry_archetype: params.mutation.archetype,
      equity_mutation_context: 'true',
      limited_takeover: 'true',
      limited_takeover_sizing_multiplier: params.mutation.sizeMultiplier,
      equity_mutation_strict_breakout: String(params.mutation.strictBreakout),
      equity_mutation_limited_takeover: String(params.mutation.limitedTakeover),
      equity_mutation_score: params.mutation.score,
      equity_mutation_reasons: params.mutation.reasons.join('|'),
      equity_mutation_risk_haircuts: params.mutation.riskHaircuts.join('|'),
      equity_mutation_stop_risk_pct: params.mutation.stopRiskPct,
      equity_mutation_stop_risk_atr: params.mutation.stopRiskAtr,
      vwap_fast_acceptance: String(params.mutation.vwapFastAcceptance),
      vwap_fast_reasons: params.mutation.vwapFastReasons.join('|'),
      vwap_fast_blockers: params.mutation.vwapFastBlockers.join('|'),
      vwap_slow_context: params.mutation.vwapSlowContext,
      htf_hard_block: String(params.mutation.htfHardBlock),
      one_h_demand_required: 'false',
      one_h_demand_role: 'evidence_not_hard_gate',
      structural_stop_source: stopPlan.source,
      structural_stop_method: stopPlan.method,
    },
  })
}

function stateReason(state: S12IntradayState, extra?: string): string {
  if (extra) return extra
  switch (state) {
    case 'waiting_15m_completed_bars': return 's12_waiting_15m_completed_bars'
    case 'waiting_session_60m_completed_bar': return 's12_waiting_session_60m_completed_bar'
    case 'waiting_session_60m_long_bias': return 's12_waiting_session_60m_long_bias'
    case 'waiting_session_60m_bearish_risk': return 's12_waiting_session_60m_bearish_risk'
    case 'waiting_4h_completed_bar': return 's12_waiting_4h_completed_bar'
    case 'waiting_4h_long_bias': return 's12_waiting_4h_long_bias'
    case 'waiting_1h_completed_bar': return 's12_waiting_1h_completed_bar'
    case 'waiting_1h_demand_zone': return 's12_waiting_1h_demand_zone'
    case 'waiting_15m_zone_touch': return 's12_waiting_15m_zone_touch'
    case 'waiting_sweep': return 's12_waiting_sweep'
    case 'waiting_choch': return 's12_waiting_choch'
    case 'waiting_bos': return 's12_waiting_bos'
    case 'waiting_retest': return 's12_waiting_retest'
    case 'waiting_reaction': return 's12_waiting_reaction'
    case 'limited_takeover_ready': return 's12_limited_takeover_ready'
    case 'reaction_ready': return 's12_reaction_ready'
    case 'bearish_defense_ready': return 's12_bearish_defense_ready'
    case 'invalidated': return 's12_structure_invalidated'
  }
}

function completeAssessment(params: {
  input: S12IntradayInput
  state: S12IntradayState
  reason?: string
  completedBars: S12IntradayAssessment['completedBars']
  bias4h: S12Bias4h
  bias1h?: S12HtfBias
  demandZone1h: S12IntradayZone | null
  supplyZone1h?: S12IntradayZone | null
  bearishDefense?: S12BearishDefense
  quality?: S12StructureQuality
  exitPlan?: S12StructureExitPlan
  sequence: S12IntradayAssessment['sequence']
  execution?: S12IntradayAssessment['execution']
  setupId?: string | null
  extraDetail?: Record<string, unknown>
}): S12IntradayAssessment {
  const ready = params.state === 'reaction_ready' || params.state === 'limited_takeover_ready'
  const invalidated = params.state === 'invalidated'
  const reason = stateReason(params.state, params.reason)
  const stale = String(params.extraDetail?.stale ?? '').toLowerCase() === 'true'
  const staleReason = params.extraDetail?.stale_reason == null ? null : String(params.extraDetail.stale_reason)
  const staleAfterBars = params.extraDetail?.stale_after_15m_bars == null ? null : Number(params.extraDetail.stale_after_15m_bars)
  const elapsedBars = params.extraDetail?.elapsed_15m_bars == null ? null : Number(params.extraDetail.elapsed_15m_bars)
  const policy = inputTimingPolicy(params.input)
  const coverage =
    (params.completedBars.session60 ?? params.completedBars.h4) >= policy.fullCoverageSession60Bars &&
    params.completedBars.h1 >= policy.fullCoverage1hBars &&
    params.completedBars.m15 >= policy.fullCoverage15mBars
    ? 'full'
    : 'partial'
  const bias1h = params.bias1h ?? { direction: 'neutral', confidence: 'none', channelAlign: false }
  const supplyZone1h = params.supplyZone1h ?? null
  const bearishDefense = params.bearishDefense ?? emptyBearishDefense(
    supplyZone1h ? 'waiting_supply_zone_touch' : 'no_supply_zone',
    supplyZone1h ? 's12_bearish_defense_waiting_supply_touch' : 's12_bearish_defense_no_supply_zone',
    {},
    supplyZone1h,
  )
  const defensiveAction: S12DefensiveAction =
    params.state === 'bearish_defense_ready'
      ? 'NO_BUY'
      : bearishDefense.action
  const quality = params.quality ?? emptyQuality()
  const rawExitPlan = params.exitPlan ?? emptyExitPlan(bearishDefense)
  const entryPrice = finitePositive(params.execution?.entryPrice)
  const exitPlan = normalizeExitPlanForTwEquity(rawExitPlan, entryPrice, finitePositive(params.input.h4ReferenceClose))
  const normalizedExecution: S12IntradayAssessment['execution'] = {
    ...(params.execution ?? {}),
    stopLoss: exitPlan.trailingStop.initial ?? params.execution?.stopLoss ?? null,
    target1: exitPlan.tp1.price,
    target2: exitPlan.mainExit.price,
    target3: exitPlan.tp3.price,
    target4: exitPlan.tp4.price,
  }
  const h4Source = params.input.h4Source ?? (params.completedBars.h4 > 0 ? 'current_session' : 'unavailable')
  const sessionContextSource: S12IntradayAssessment['sessionContextSource'] = h4Source === 'previous_trading_day_fallback'
    ? 'previous_session_60m'
    : (params.completedBars.session60 ?? params.completedBars.h4) > 0
      ? 'current_session_60m'
      : 'unavailable'
  const barDiagnostics = params.input.barDiagnostics ?? {}
  const maturity = maturitySnapshot(params.state, params.sequence, {
    stale,
    staleReason,
    staleAfterBars: Number.isFinite(staleAfterBars) ? staleAfterBars : null,
    elapsedBars: Number.isFinite(elapsedBars) ? elapsedBars : null,
  })
  return {
    version: 's12_intraday_structure_v1',
    engineVersion: 's12_smcvwap_tw_equity_v2',
    symbol: params.input.symbol,
    direction: 'long',
    state: params.state,
    entryState: entryStateFor(params.state),
    ready,
    invalidated,
    reason,
    detail: detailText({
      state: params.state,
      entry_state: entryStateFor(params.state),
      reason,
      setup_id: params.setupId ?? null,
      coverage,
      bars15m: params.completedBars.m15,
      bars1h: params.completedBars.h1,
      bars_session_60m: params.completedBars.session60 ?? params.completedBars.h4,
      session_context_source: sessionContextSource,
      h4_reference_date: params.input.h4ReferenceDate ?? null,
      h4_reference_close: price(params.input.h4ReferenceClose),
      previous_session_60m_bias_mode: sessionContextSource === 'previous_session_60m' ? 'context_only' : null,
      ...timingPolicyDetail(policy),
      bias_session_60m: params.bias4h.direction,
      bias_confidence: params.bias4h.confidence,
      bias_channel_align: params.bias4h.channelAlign ? 'true' : 'false',
      bias1h: bias1h.direction,
      bias1h_confidence: bias1h.confidence,
      bias1h_channel_align: bias1h.channelAlign ? 'true' : 'false',
      zone_low: price(params.demandZone1h?.low),
      zone_high: price(params.demandZone1h?.high),
      zone_type: params.demandZone1h?.type,
      supply_zone_low: price(supplyZone1h?.low),
      supply_zone_high: price(supplyZone1h?.high),
      supply_zone_type: supplyZone1h?.type,
      bearish_defense_state: bearishDefense.state,
      bearish_defense_action: defensiveAction === 'none' ? null : defensiveAction,
      vwap: quality.vwap.value,
      price_vwap_pct: quality.vwap.priceVsVwapPct,
      vwap_state: quality.vwap.state,
      vwap_context_schema: quality.vwapContext.schemaVersion,
      vwap_stack: quality.vwapContext.stackState,
      vwap_confluence_width_pct: quality.vwapContext.confluenceWidthPct,
      vwap_session: quality.vwapContext.session.value,
      vwap_h1: quality.vwapContext.h1.value,
      vwap_session_60m: quality.vwapContext.session60.value,
      vwap_daily: quality.vwapContext.daily.value,
      vwap_anchor_day: quality.vwapContext.anchored.day.value,
      vwap_anchor_week: quality.vwapContext.anchored.week.value,
      vwap_anchor_month: quality.vwapContext.anchored.month.value,
      vwap_anchor_quarter: quality.vwapContext.anchored.quarter.value,
      vwap_anchor_year: quality.vwapContext.anchored.year.value,
      vwap_rolling_7d: quality.vwapContext.rollingDays.days7.value,
      vwap_rolling_30d: quality.vwapContext.rollingDays.days30.value,
      vwap_rolling_90d: quality.vwapContext.rollingDays.days90.value,
      vwap_rolling_365d: quality.vwapContext.rollingDays.days365.value,
      vwap_previous_day: quality.vwapContext.previousPeriodZones.day?.value ?? null,
      vwap_previous_week: quality.vwapContext.previousPeriodZones.week?.value ?? null,
      vwap_previous_month: quality.vwapContext.previousPeriodZones.month?.value ?? null,
      vwap_nearest_above: quality.vwapContext.nearestAbove?.price ?? null,
      vwap_nearest_above_source: quality.vwapContext.nearestAbove?.source ?? null,
      vwap_nearest_below: quality.vwapContext.nearestBelow?.price ?? null,
      vwap_nearest_below_source: quality.vwapContext.nearestBelow?.source ?? null,
      ib_high: quality.vwapContext.initialBalance.high,
      ib_low: quality.vwapContext.initialBalance.low,
      ib_state: quality.vwapContext.initialBalance.state,
      rvol: quality.rvol.value,
      rvol_state: quality.rvol.state,
      rvol_lookback_bars: quality.rvol.lookbackBars,
      quality_notes: quality.notes.length ? quality.notes.join('|') : null,
      structural_tp1: exitPlan.tp1.price,
      structural_tp1_source: exitPlan.tp1.source === 'unavailable' ? null : exitPlan.tp1.source,
      structural_main_exit: exitPlan.mainExit.price,
      structural_main_exit_source: exitPlan.mainExit.source === 'unavailable' ? null : exitPlan.mainExit.source,
      structural_tp3: exitPlan.tp3.price,
      structural_tp3_source: exitPlan.tp3.source === 'unavailable' ? null : exitPlan.tp3.source,
      structural_tp4: exitPlan.tp4.price,
      structural_tp4_source: exitPlan.tp4.source === 'unavailable' ? null : exitPlan.tp4.source,
      manual_tp: null,
      manual_tp_source: null,
      trailing_method: exitPlan.trailingStop.method,
      trailing_source: exitPlan.trailingStop.source,
      reverse_warning_action: exitPlan.reverseWarning.action === 'none' ? null : exitPlan.reverseWarning.action,
      entry: price(normalizedExecution.entryPrice),
      chase_ceiling: price(normalizedExecution.chaseCeiling),
      stop: price(normalizedExecution.stopLoss),
      t1: price(normalizedExecution.target1),
      t2: price(normalizedExecution.target2),
      t3: price(normalizedExecution.target3),
      t4: price(normalizedExecution.target4),
      atr15m: price(normalizedExecution.atr15m),
      r: normalizedExecution.rMultiple == null ? null : round(normalizedExecution.rMultiple, 4),
      takeover_eligible: maturity.takeoverEligible ? 'true' : 'false',
      takeover_role: maturity.takeoverRole,
      maturity_tier: maturity.tier,
      maturity_risk_mode: maturity.riskMode,
      maturity_stage: maturityStage(params.state),
      maturity_policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
      stale: stale ? 'true' : null,
      stale_reason: staleReason,
      stale_after_15m_bars: Number.isFinite(staleAfterBars) ? staleAfterBars : null,
      elapsed_15m_bars: Number.isFinite(elapsedBars) ? elapsedBars : null,
      ...barDiagnostics,
      ...params.extraDetail,
    }),
    setupId: params.setupId ?? null,
    completedBars: params.completedBars,
    sessionContextSource,
    h4Source,
    h4ReferenceDate: params.input.h4ReferenceDate ?? null,
    h4ReferenceClose: price(params.input.h4ReferenceClose),
    barDiagnostics,
    coverage,
    bias4h: params.bias4h,
    biasSession60: params.bias4h,
    bias1h,
    demandZone1h: params.demandZone1h,
    supplyZone1h,
    bearishDefense,
    defensiveAction,
    quality,
    exitPlan,
    sequence: params.sequence,
    execution: normalizedExecution,
    maturity,
  }
}

function parseS12Assessment(raw: unknown): S12IntradayAssessment | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return parseS12Assessment(JSON.parse(raw))
    } catch {
      return null
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.version === 's12_intraday_structure_v1') return record as unknown as S12IntradayAssessment
  if (record.detail_json) return parseS12Assessment(record.detail_json)
  if (record.detail) return parseS12Assessment(record.detail)
  return null
}

export function applyS12TakeoverContinuity(
  current: S12IntradayAssessment,
  previousRaw: unknown,
  options: { minZoneOverlap?: number } = {},
): S12IntradayAssessment {
  const previous = parseS12Assessment(previousRaw)
  if (!previous || previous.symbol !== current.symbol) return current
  if (current.maturity?.takeoverRole === 'long_entry') return current
  if (current.invalidated || current.state === 'invalidated' || current.state === 'bearish_defense_ready') return current
  if (previous.invalidated || previous.state === 'invalidated' || previous.state === 'bearish_defense_ready') return current
  if (!previous.ready) return current
  if (previous.maturity?.takeoverRole !== 'long_entry') return current
  if (previous.maturity?.stale) return current
  if (!previous.demandZone1h || !current.demandZone1h) return current
  if (previous.sequence?.zoneTouchMs == null) return current

  const minZoneOverlap = Math.max(0.5, Math.min(1, options.minZoneOverlap ?? 0.8))
  const zoneOverlap = zoneOverlapCoverage(previous.demandZone1h, current.demandZone1h)
  if (zoneOverlap < minZoneOverlap) return current

  const preservedMaturity: S12IntradayAssessment['maturity'] = {
    ...previous.maturity,
    takeoverEligible: true,
    takeoverRole: 'long_entry',
    blocker: previous.maturity?.blocker ?? previous.state,
    stage: previous.maturity?.stage ?? maturityStage(previous.state),
    policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated',
  }
  return {
    ...current,
    state: previous.state,
    ready: previous.ready,
    invalidated: false,
    reason: previous.reason,
    detail: detailWithOverrides(current.detail, {
      state: previous.state,
      reason: previous.reason,
      setup_id: previous.setupId,
      zone_low: price(previous.demandZone1h.low),
      zone_high: price(previous.demandZone1h.high),
      zone_type: previous.demandZone1h.type,
      entry: price(previous.execution?.entryPrice),
      chase_ceiling: price(previous.execution?.chaseCeiling),
      stop: price(previous.execution?.stopLoss),
      takeover_eligible: 'true',
      takeover_role: 'long_entry',
      maturity_tier: preservedMaturity.tier,
      maturity_risk_mode: preservedMaturity.riskMode,
      maturity_stage: preservedMaturity.stage,
      maturity_blocker: preservedMaturity.blocker,
      takeover_continuity: 'preserved',
      continuity_reason: 'overlapping_zone_reselected',
      continuity_zone_overlap: round(zoneOverlap, 4),
      continuity_previous_state: previous.state,
      continuity_current_state: current.state,
      continuity_previous_zone_type: previous.demandZone1h.type,
      continuity_current_zone_type: current.demandZone1h.type,
    }),
    setupId: previous.setupId ?? current.setupId,
    demandZone1h: previous.demandZone1h,
    sequence: { ...previous.sequence },
    execution: {
      ...previous.execution,
      atr15m: current.execution?.atr15m ?? previous.execution?.atr15m ?? null,
    },
    exitPlan: previous.exitPlan ?? current.exitPlan,
    maturity: preservedMaturity,
  }
}

function lastBearishBar(bars: S12Bar[], start: number, endInclusive: number): S12Bar | null {
  for (let i = Math.min(endInclusive, bars.length - 1); i >= Math.max(0, start); i -= 1) {
    if (bars[i].close < bars[i].open) return bars[i]
  }
  return null
}

function lastBullishBar(bars: S12Bar[], start: number, endInclusive: number): S12Bar | null {
  for (let i = Math.min(endInclusive, bars.length - 1); i >= Math.max(0, start); i -= 1) {
    if (bars[i].close > bars[i].open) return bars[i]
  }
  return null
}

function defensiveDetail(
  state: S12BearishDefense['state'],
  reason: string,
  supplyZone1h: S12IntradayZone | null,
  sequence: S12BearishDefense['sequence'],
  extra: Record<string, unknown> = {},
): string {
  return detailText({
    state,
    reason,
    supply_zone_low: price(supplyZone1h?.low),
    supply_zone_high: price(supplyZone1h?.high),
    supply_zone_type: supplyZone1h?.type,
    zone_touch_ms: sequence.zoneTouchMs ?? null,
    sweep_ms: sequence.sweepMs ?? null,
    choch_ms: sequence.chochMs ?? null,
    bos_ms: sequence.bosMs ?? null,
    retest_ms: sequence.retestMs ?? null,
    reaction_ms: sequence.reactionMs ?? null,
    ...extra,
  })
}

function bearishDefenseAssessment(params: {
  state: S12BearishDefense['state']
  reason: string
  supplyZone1h: S12IntradayZone | null
  sequence?: S12BearishDefense['sequence']
  action?: S12DefensiveAction
  extra?: Record<string, unknown>
}): S12BearishDefense {
  const sequence = params.sequence ?? {}
  const ready = params.state === 'bearish_defense_ready'
  const action = params.action ?? (ready ? 'NO_BUY' : 'none')
  return {
    state: params.state,
    ready,
    action,
    reason: params.reason,
    detail: defensiveDetail(params.state, params.reason, params.supplyZone1h, sequence, params.extra),
    supplyZone1h: params.supplyZone1h,
    sequence,
  }
}

function scanBearishDefenseSequence(params: {
  input: S12IntradayInput
  bars15m: S12Bar[]
  supplyZone1h: S12IntradayZone | null
  policy: S12TimingPolicy
}): S12BearishDefense {
  const { bars15m, supplyZone1h, policy } = params
  if (!supplyZone1h) {
    return bearishDefenseAssessment({
      state: 'no_supply_zone',
      reason: 's12_bearish_defense_no_supply_zone',
      supplyZone1h: null,
    })
  }
  const atr15m = averageTrueRange(bars15m, policy.atr15mBars) ?? Math.max(0.01, bars15m[bars15m.length - 1].high - bars15m[bars15m.length - 1].low)
  const eligibleBars = bars15m.filter((bar) => bar.startMs >= supplyZone1h.createdMs)
  const offset = bars15m.length - eligibleBars.length
  const touchRelative = eligibleBars.findIndex((bar) => overlapsZone(bar, supplyZone1h))
  if (touchRelative < 0) {
    return bearishDefenseAssessment({
      state: 'waiting_supply_zone_touch',
      reason: 's12_bearish_waiting_supply_zone_touch',
      supplyZone1h,
      extra: { elapsed_15m_bars: eligibleBars.length },
    })
  }
  const touchIndex = offset + touchRelative
  const touch = bars15m[touchIndex]

  let sweepIndex = -1
  const sweepEnd = Math.min(bars15m.length - 1, touchIndex + policy.sweepWaitBars)
  for (let i = touchIndex; i <= sweepEnd; i += 1) {
    const priorHigh = highBetween(bars15m, Math.max(0, i - policy.swingLookbackBars), i)
    if (priorHigh == null) continue
    const bar = bars15m[i]
    const priorUp = bars15m.slice(Math.max(0, i - policy.priorDirectionalBars), i).some((candidate) => candidate.close > candidate.open)
    const rejected = bar.close < Math.min(supplyZone1h.high, bar.high - atr15m * 0.12)
    if (priorUp && bar.high > priorHigh && rejected && bar.high >= supplyZone1h.low) {
      sweepIndex = i
      break
    }
  }
  if (sweepIndex < 0) {
    return bearishDefenseAssessment({
      state: 'waiting_bsl_sweep',
      reason: 's12_bearish_waiting_bsl_sweep',
      supplyZone1h,
      sequence: { zoneTouchMs: touch.startMs },
      action: 'LOWER_CONFIDENCE',
      extra: { elapsed_15m_bars: Math.max(0, bars15m.length - 1 - touchIndex) },
    })
  }
  const sweep = bars15m[sweepIndex]

  let chochIndex = -1
  const chochLevel = lowBetween(bars15m, Math.max(0, sweepIndex - policy.swingLookbackBars), sweepIndex + 1)
  const chochEnd = Math.min(bars15m.length - 1, sweepIndex + policy.chochWaitBars)
  for (let i = sweepIndex + 1; i <= chochEnd; i += 1) {
    const bar = bars15m[i]
    const body = Math.abs(bar.close - bar.open)
    if (chochLevel != null && bar.close < chochLevel && bar.close < bar.open && body >= atr15m * 0.08) {
      chochIndex = i
      break
    }
  }
  if (chochIndex < 0) {
    return bearishDefenseAssessment({
      state: 'waiting_choch_down',
      reason: 's12_bearish_waiting_choch_down',
      supplyZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs },
      action: 'LOWER_CONFIDENCE',
      extra: { elapsed_15m_bars: Math.max(0, bars15m.length - 1 - sweepIndex) },
    })
  }
  const choch = bars15m[chochIndex]

  let bosIndex = -1
  const bosLevel = lowBetween(bars15m, touchIndex, chochIndex + 1)
  const bosEnd = Math.min(bars15m.length - 1, chochIndex + policy.bosWaitBars)
  for (let i = chochIndex + 1; i <= bosEnd; i += 1) {
    const bar = bars15m[i]
    const lowerHigh = highBetween(bars15m, chochIndex + 1, i + 1)
    if (bosLevel != null && bar.close < bosLevel && (lowerHigh == null || lowerHigh < sweep.high)) {
      bosIndex = i
      break
    }
  }
  if (bosIndex < 0) {
    return bearishDefenseAssessment({
      state: 'waiting_bos_down',
      reason: 's12_bearish_waiting_bos_down',
      supplyZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs, chochMs: choch.startMs },
      action: 'LOWER_CONFIDENCE',
      extra: { elapsed_15m_bars: Math.max(0, bars15m.length - 1 - chochIndex) },
    })
  }
  const bos = bars15m[bosIndex]
  const ob = lastBullishBar(bars15m, chochIndex, bosIndex) ?? sweep
  const entryZone = {
    low: Math.min(ob.open, ob.close),
    high: Math.max(ob.high, ob.close),
  }

  let reactionIndex = -1
  const retestEnd = Math.min(bars15m.length - 1, bosIndex + policy.retestWaitBars)
  for (let i = bosIndex + 1; i <= retestEnd; i += 1) {
    const bar = bars15m[i]
    const retest = bar.low <= entryZone.high && bar.high >= entryZone.low
    const reaction = retest && bar.close < bar.open && bar.close <= Math.max(entryZone.low, bar.open - atr15m * 0.08)
    if (reaction) {
      reactionIndex = i
      break
    }
  }
  if (reactionIndex < 0) {
    return bearishDefenseAssessment({
      state: 'waiting_bearish_retest',
      reason: 's12_bearish_waiting_retest_reaction',
      supplyZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs, chochMs: choch.startMs, bosMs: bos.startMs },
      action: 'LOWER_CONFIDENCE',
      extra: {
        entry_zone_low: price(entryZone.low),
        entry_zone_high: price(entryZone.high),
        elapsed_15m_bars: Math.max(0, bars15m.length - 1 - bosIndex),
      },
    })
  }
  const reaction = bars15m[reactionIndex]
  return bearishDefenseAssessment({
    state: 'bearish_defense_ready',
    reason: 's12_bearish_defense_ready',
    supplyZone1h,
    sequence: {
      zoneTouchMs: touch.startMs,
      sweepMs: sweep.startMs,
      chochMs: choch.startMs,
      bosMs: bos.startMs,
      retestMs: reaction.startMs,
      reactionMs: reaction.startMs,
    },
    action: 'NO_BUY',
    extra: {
      entry_zone_low: price(entryZone.low),
      entry_zone_high: price(entryZone.high),
      reaction_close: price(reaction.close),
    },
  })
}

function nearestPriorHighsAbove(bars: S12Bar[], start: number, endInclusive: number, entryPrice: number): number[] {
  const seen = new Set<number>()
  return bars
    .slice(Math.max(0, start), Math.min(bars.length, endInclusive + 1))
    .map((bar) => bar.high)
    .filter((value) => Number.isFinite(value) && value > entryPrice)
    .map((value) => price(value))
    .filter((value): value is number => value != null)
    .filter((value) => {
      const key = Math.round(value * 100)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a - b)
}

function nearestPriorHighAbove(bars: S12Bar[], start: number, endInclusive: number, entryPrice: number): number | null {
  return nearestPriorHighsAbove(bars, start, endInclusive, entryPrice)[0] ?? null
}

type S12LongTargetSource = '15m_previous_high' | '1h_supply_zone' | 'vwap_fair_value' | 'tp_ladder'

interface S12LongTargetCandidate {
  price: number
  source: S12LongTargetSource
  detail: string
}

function uniqueSortedTargets(candidates: S12LongTargetCandidate[]): S12LongTargetCandidate[] {
  const seen = new Set<string>()
  return candidates
    .filter((candidate) => candidate.price > 0)
    .map((candidate) => ({ ...candidate, price: price(candidate.price)! }))
    .sort((a, b) => a.price - b.price)
    .filter((candidate) => {
      const key = `${candidate.price}:${candidate.source}:${candidate.detail}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function vwapTargetCandidatesAbove(
  context: S12StructureQuality['vwapContext'],
  entryPrice: number,
): S12LongTargetCandidate[] {
  const minDistance = Math.max(0.01, entryPrice * 0.003)
  const raw: Array<{ value: number | null; detail: string }> = [
    { value: context.h1.value, detail: 'h1_vwap' },
    { value: context.h4.value, detail: 'h4_vwap' },
    { value: context.daily.value, detail: 'daily_vwap' },
    { value: context.anchored.day.value, detail: 'anchored_day_vwap' },
    { value: context.anchored.week.value, detail: 'anchored_week_vwap' },
    { value: context.anchored.month.value, detail: 'anchored_month_vwap' },
    { value: context.anchored.quarter.value, detail: 'anchored_quarter_vwap' },
    { value: context.anchored.year.value, detail: 'anchored_year_vwap' },
    { value: context.rolling15m.bars30.value, detail: 'rolling15m_30_vwap' },
    { value: context.rolling15m.bars90.value, detail: 'rolling15m_90_vwap' },
    { value: context.rollingDays.days7.value, detail: 'rolling7d_vwap' },
    { value: context.rollingDays.days30.value, detail: 'rolling30d_vwap' },
    { value: context.rollingDays.days90.value, detail: 'rolling90d_vwap' },
    { value: context.rollingDays.days365.value, detail: 'rolling365d_vwap' },
    { value: context.previousZones.h1?.value ?? null, detail: 'previous_h1_vwap_mid' },
    { value: context.previousZones.h1?.upper ?? null, detail: 'previous_h1_vwap_upper' },
    { value: context.previousZones.h4?.value ?? null, detail: 'previous_h4_vwap_mid' },
    { value: context.previousZones.h4?.upper ?? null, detail: 'previous_h4_vwap_upper' },
    { value: context.previousZones.daily?.value ?? null, detail: 'previous_daily_vwap_mid' },
    { value: context.previousZones.daily?.upper ?? null, detail: 'previous_daily_vwap_upper' },
    { value: context.previousPeriodZones.day?.value ?? null, detail: 'previous_day_vwap_mid' },
    { value: context.previousPeriodZones.day?.upper ?? null, detail: 'previous_day_vwap_upper' },
    { value: context.previousPeriodZones.week?.value ?? null, detail: 'previous_week_vwap_mid' },
    { value: context.previousPeriodZones.week?.upper ?? null, detail: 'previous_week_vwap_upper' },
    { value: context.previousPeriodZones.month?.value ?? null, detail: 'previous_month_vwap_mid' },
    { value: context.previousPeriodZones.month?.upper ?? null, detail: 'previous_month_vwap_upper' },
    { value: context.previousPeriodZones.quarter?.value ?? null, detail: 'previous_quarter_vwap_mid' },
    { value: context.previousPeriodZones.quarter?.upper ?? null, detail: 'previous_quarter_vwap_upper' },
    { value: context.previousPeriodZones.year?.value ?? null, detail: 'previous_year_vwap_mid' },
    { value: context.previousPeriodZones.year?.upper ?? null, detail: 'previous_year_vwap_upper' },
    context.nearestAbove?.source === 'session_vwap' || context.nearestAbove?.source === 'rolling15m_7'
      ? { value: null, detail: 'nearest_above_reactive_vwap_ignored' }
      : { value: context.nearestAbove?.price ?? null, detail: `nearest_above_${context.nearestAbove?.source ?? 'none'}` },
  ]
  return uniqueSortedTargets(
    raw
      .filter((item): item is { value: number; detail: string } => item.value != null && item.value > entryPrice + minDistance)
      .map((item) => ({
        price: item.value,
        source: 'vwap_fair_value',
        detail: item.detail,
      })),
  )
}

function nextCandidateTargetAbove(
  candidates: S12LongTargetCandidate[],
  minExclusive: number,
  fallback: number | null,
): {
  price: number | null
  source: S12StructureExitPlan['mainExit']['source'] | '15m_previous_high'
  detail: string | null
} {
  const structural = uniqueSortedTargets(candidates)
    .find((candidate) => candidate.price > minExclusive + 0.01) ?? null
  if (structural) return { price: structural.price, source: structural.source, detail: structural.detail }
  if (fallback != null && fallback > minExclusive + 0.01) {
    return { price: fallback, source: 'r_multiple_fallback', detail: null }
  }
  return { price: null, source: 'unavailable', detail: null }
}

function latestBullishFvg15mStop(
  bars: S12Bar[],
  endInclusive: number,
  entryPrice: number,
  atr15m: number,
  policy: S12TimingPolicy,
): number | null {
  for (let i = Math.min(endInclusive, bars.length - 1); i >= 2; i -= 1) {
    const left = bars[i - 2]
    const current = bars[i]
    const gap = current.low - left.high
    if (gap < Math.max(0.01, atr15m * policy.minFvgAtr)) continue
    const stop = left.high - atr15m * 0.1
    if (stop > 0 && stop < entryPrice) return price(stop)
  }
  return null
}

function confirmedPivotLow(bars: S12Bar[], pivotIndex: number, pivotLen: number): boolean {
  const pivot = bars[pivotIndex]
  if (!pivot) return false
  for (let i = pivotIndex - pivotLen; i <= pivotIndex + pivotLen; i += 1) {
    if (i < 0 || i >= bars.length || i === pivotIndex) continue
    if (bars[i].low < pivot.low) return false
  }
  return true
}

function confirmedPivotHigh(bars: S12Bar[], pivotIndex: number, pivotLen: number): boolean {
  const pivot = bars[pivotIndex]
  if (!pivot) return false
  for (let i = pivotIndex - pivotLen; i <= pivotIndex + pivotLen; i += 1) {
    if (i < 0 || i >= bars.length || i === pivotIndex) continue
    if (bars[i].high > pivot.high) return false
  }
  return true
}

function removeBrokenBullishZones(zones: S12IntradayZone[], close: number): S12IntradayZone[] {
  return zones.filter((zone) => close >= zone.low)
}

function updateBullishFvgZones(zones: S12IntradayZone[], low: number): S12IntradayZone[] {
  const next: S12IntradayZone[] = []
  for (const zone of zones) {
    if (low <= zone.low) continue
    next.push({
      ...zone,
      high: low < zone.high ? round(low, 4) : zone.high,
    })
  }
  return next
}

function nearestZoneBelow(zones: S12IntradayZone[], referencePrice: number): S12IntradayZone | null {
  let best: S12IntradayZone | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const zone of zones) {
    if (!(zone.low < referencePrice)) continue
    const distance = Math.max(referencePrice - zone.high, 0)
    if (distance < bestDistance) {
      best = zone
      bestDistance = distance
    }
  }
  return best
}

function pushZone(zones: S12IntradayZone[], zone: S12IntradayZone, maxCount: number): S12IntradayZone[] {
  const next = [...zones, zone]
  while (next.length > maxCount) next.shift()
  return next
}

export function buildS12LongPositionStopPlan(params: {
  bars15m: S12Bar[]
  entryPrice: number
  referencePrice?: number | null
  policy?: Partial<S12TimingPolicy> | null
  stopSource?: S12PositionStopSource | null
  minConfirmationBars?: number
}): S12PositionStopPlan | null {
  const bars = normalizeBars(params.bars15m)
  const entryPrice = Number(params.entryPrice)
  const rawReferencePrice = Number(params.referencePrice)
  const referencePrice = Number.isFinite(rawReferencePrice) && rawReferencePrice > 0 ? rawReferencePrice : entryPrice
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || bars.length < 3) return null

  const policy = normalizeS12TimingPolicy(params.policy)
  const pivotLen = policy.swingLookbackBars
  const maxZones = policy.maxVisibleZones
  const atr = averageTrueRange(bars, policy.srAtrLen) ?? Math.max(0.01, bars[bars.length - 1].high - bars[bars.length - 1].low)
  const fvgThreshold = Math.max(0.01, atr * policy.minFvgAtr)

  let structHigh: number | null = null
  let structLow: number | null = null
  let structHighBroken = false
  let bullObs: S12IntradayZone[] = []
  let bullFvgs: S12IntradayZone[] = []

  for (let i = 0; i < bars.length; i += 1) {
    const current = bars[i]
    const pivotIndex = i - pivotLen
    if (pivotIndex >= pivotLen) {
      if (confirmedPivotHigh(bars, pivotIndex, pivotLen)) {
        structHigh = bars[pivotIndex].high
        structHighBroken = false
      }
      if (confirmedPivotLow(bars, pivotIndex, pivotLen)) {
        structLow = bars[pivotIndex].low
      }
    }

    const previous = bars[i - 1]
    if (previous && structHigh != null && !structHighBroken && current.close > structHigh && previous.close <= structHigh) {
      const ob = lastBearishBar(bars, Math.max(0, i - policy.obLookbackBars), i - 1) ?? previous
      const zoneTop = Math.max(ob.open, ob.close)
      const zoneBottom = Math.min(ob.open, ob.close)
      bullObs = pushZone(bullObs, {
        type: 'bullish_order_block',
        low: round(Math.min(zoneTop, zoneBottom), 4),
        high: round(Math.max(zoneTop, zoneBottom), 4),
        createdMs: current.startMs + M15_MS,
        ageBars: bars.length - 1 - i,
      }, maxZones)
      structHighBroken = true
    }
    bullObs = removeBrokenBullishZones(bullObs, current.close)

    if (i >= 2) {
      const left = bars[i - 2]
      const gap = current.low - left.high
      if (gap >= fvgThreshold) {
        bullFvgs = pushZone(bullFvgs, {
          type: 'bullish_fvg',
          low: round(left.high, 4),
          high: round(current.low, 4),
          createdMs: current.startMs + M15_MS,
          ageBars: bars.length - 1 - i,
        }, maxZones)
      }
    }
    bullFvgs = updateBullishFvgZones(bullFvgs, current.low)
  }

  const protectedLow = structLow != null && structLow < referencePrice
    ? {
      price: price(structLow),
      zoneLow: price(structLow),
      zoneHigh: price(structLow),
      source: '15m_protected_low' as const,
      method: '15m_protected_low' as const,
    }
    : null
  const fvg = nearestZoneBelow(bullFvgs, referencePrice)
  const fvgStop = fvg != null && fvg.high < referencePrice
    ? {
      price: price(fvg.high),
      zoneLow: price(fvg.low),
      zoneHigh: price(fvg.high),
      source: '15m_recent_fvg' as const,
      method: '15m_recent_bullish_fvg' as const,
      ageBars: fvg.ageBars,
    }
    : null
  const ob = nearestZoneBelow(bullObs, referencePrice)
  const obStop = ob != null && ob.low < referencePrice
    ? {
      price: price(ob.low),
      zoneLow: price(ob.low),
      zoneHigh: price(ob.high),
      source: '15m_order_block' as const,
      method: '15m_bullish_order_block' as const,
      ageBars: ob.ageBars,
    }
    : null

  type Candidate = Omit<S12PositionStopPlan, 'noAtrBuffer'> & { ageBars?: number }
  const rawCandidates: Array<Candidate | null> = [
    protectedLow != null && protectedLow.price != null && protectedLow.zoneLow != null && protectedLow.zoneHigh != null
      ? { ...protectedLow, price: protectedLow.price, zoneLow: protectedLow.zoneLow, zoneHigh: protectedLow.zoneHigh, ageBars: policy.swingLookbackBars }
      : null,
    fvgStop != null && fvgStop.price != null && fvgStop.zoneLow != null && fvgStop.zoneHigh != null
      ? { ...fvgStop, price: fvgStop.price, zoneLow: fvgStop.zoneLow, zoneHigh: fvgStop.zoneHigh }
      : null,
    obStop != null && obStop.price != null && obStop.zoneLow != null && obStop.zoneHigh != null
      ? { ...obStop, price: obStop.price, zoneLow: obStop.zoneLow, zoneHigh: obStop.zoneHigh }
      : null,
  ]
  const candidates = rawCandidates.filter((candidate): candidate is Candidate => (
    candidate != null &&
    candidate.price > 0 &&
    candidate.price < referencePrice &&
    (candidate.ageBars ?? 0) >= Math.max(0, Math.floor(params.minConfirmationBars ?? 0))
  ))
  const requested = params.stopSource ?? policy.positionStopSource
  const selected = requested === 'adaptive'
    ? candidates.sort((a, b) => b.price - a.price)[0] ?? null
    : candidates.find((candidate) => candidate.source === requested) ?? null
  return selected
    ? {
      price: normalizeTwEquityStopPrice(selected.price),
      source: selected.source,
      method: selected.method,
      zoneLow: normalizeTwEquityStopPrice(selected.zoneLow),
      zoneHigh: normalizeTwEquityStopPrice(selected.zoneHigh),
      noAtrBuffer: true,
    }
    : null
}

function latestBullishOrderBlock15mStop(
  bars: S12Bar[],
  start: number,
  endInclusive: number,
  entryPrice: number,
  atr15m: number,
  policy: S12TimingPolicy,
): number | null {
  for (let i = Math.min(endInclusive, bars.length - 1); i >= Math.max(1, start); i -= 1) {
    const previous = bars[i - 1]
    const current = bars[i]
    const body = Math.abs(current.close - current.open)
    const bullishDisplacement = current.close > current.open && current.close > previous.high && body >= atr15m * 0.08
    if (!bullishDisplacement) continue
    const ob = lastBearishBar(bars, Math.max(0, i - policy.obLookbackBars), i - 1) ?? previous
    const stop = ob.low - atr15m * policy.stopStructureBufferAtr
    if (stop > 0 && stop < entryPrice) return price(stop)
  }
  return null
}

function protectedLow15mStop(
  bars: S12Bar[],
  start: number,
  endInclusive: number,
  entryPrice: number,
  atr15m: number,
  policy: S12TimingPolicy,
): number | null {
  const lows = bars
    .slice(Math.max(0, start), Math.min(bars.length, endInclusive + 1))
    .map((bar) => bar.low - atr15m * policy.stopStructureBufferAtr)
    .filter((value) => Number.isFinite(value) && value > 0 && value < entryPrice)
    .sort((a, b) => b - a)
  return lows.length ? price(lows[0]) : null
}

function selectLongStopPlan(params: {
  bars15m: S12Bar[]
  sweepIndex: number
  bosIndex: number
  reactionIndex: number
  entryPrice: number
  structuralStop: number
  atr15m: number
  policy: S12TimingPolicy
}): {
  price: number
  source: S12PositionStopSource
  method: S12StructureExitPlan['trailingStop']['method']
} {
  const protectedLow = protectedLow15mStop(params.bars15m, params.sweepIndex, params.reactionIndex, params.entryPrice, params.atr15m, params.policy)
  const fvg = latestBullishFvg15mStop(params.bars15m, params.reactionIndex, params.entryPrice, params.atr15m, params.policy)
  const ob = latestBullishOrderBlock15mStop(params.bars15m, params.sweepIndex, params.bosIndex, params.entryPrice, params.atr15m, params.policy)
  type StopCandidate = {
    price: number
    source: Exclude<S12PositionStopSource, 'adaptive'>
    method: Exclude<S12StructureExitPlan['trailingStop']['method'], 'structure_stop_then_15m_higher_low_atr_vwap'>
  }
  const rawCandidates: Array<Omit<StopCandidate, 'price'> & { price: number | null }> = [
    { price: protectedLow, source: '15m_protected_low' as const, method: '15m_protected_low' as const },
    { price: fvg, source: '15m_recent_fvg' as const, method: '15m_recent_bullish_fvg' as const },
    { price: ob, source: '15m_order_block' as const, method: '15m_bullish_order_block' as const },
  ]
  const candidates = rawCandidates.filter((candidate): candidate is StopCandidate => (
    candidate.price != null && candidate.price > 0 && candidate.price < params.entryPrice
  ))
  const requested = params.policy.positionStopSource
  const selected = requested === 'adaptive'
    ? candidates.sort((a, b) => b.price - a.price)[0] ?? null
    : candidates.find((candidate) => candidate.source === requested) ?? null
  if (selected) return selected
  return {
    price: params.structuralStop,
    source: requested,
    method: 'structure_stop_then_15m_higher_low_atr_vwap',
  }
}

function buildLongExitPlan(params: {
  bars15m: S12Bar[]
  touchIndex: number
  sweepIndex: number
  bosIndex: number
  reactionIndex: number
  entryPrice: number
  stopLoss: number
  atr15m: number
  risk: number
  supplyZone1h: S12IntradayZone | null
  bearishDefense: S12BearishDefense
  quality: S12StructureQuality
  policy: S12TimingPolicy
}): S12StructureExitPlan {
  const priorHighs = nearestPriorHighsAbove(params.bars15m, params.touchIndex, params.reactionIndex, params.entryPrice)
  const priorHigh = nearestPriorHighAbove(params.bars15m, params.touchIndex, params.reactionIndex, params.entryPrice)
  const fallbackTp1 = price(params.entryPrice + params.risk)
  const supplyLow = params.supplyZone1h?.low ?? null
  const supplyHigh = params.supplyZone1h?.high ?? null
  const supplyExit = supplyLow != null && supplyLow > params.entryPrice
    ? supplyLow
    : supplyHigh != null && supplyHigh > params.entryPrice
      ? supplyHigh
      : null
  const vwapTargets = vwapTargetCandidatesAbove(params.quality.vwapContext, params.entryPrice)
  const fallbackMainExit = price(params.entryPrice + params.risk * 2)
  const fallbackTp3 = price(params.entryPrice + params.risk * 3)
  const fallbackTp4 = price(params.entryPrice + params.risk * 4)
  const tp1Vwap = priorHigh == null
    ? vwapTargets.find((candidate) => candidate.price > params.entryPrice + 0.01) ?? null
    : null
  const tp1Price = priorHigh ?? tp1Vwap?.price ?? fallbackTp1
  const mainExitCandidate = supplyExit != null
    ? { price: price(supplyExit), source: '1h_supply_zone' as const, detail: '1h_supply_zone' }
    : nextCandidateTargetAbove(vwapTargets, tp1Price ?? params.entryPrice, fallbackMainExit)
  const mainExitPrice = price(mainExitCandidate.price)
  const ladderCandidates: S12LongTargetCandidate[] = uniqueSortedTargets([
    ...priorHighs.map((value) => ({ price: value, source: '15m_previous_high' as const, detail: '15m_previous_high' })),
    ...(supplyHigh != null ? [{ price: price(supplyHigh)!, source: '1h_supply_zone' as const, detail: '1h_supply_zone_high' }] : []),
    ...vwapTargets,
  ])
  const tp3 = nextCandidateTargetAbove(
    ladderCandidates,
    mainExitPrice ?? params.entryPrice,
    fallbackTp3,
  )
  const tp4 = nextCandidateTargetAbove(ladderCandidates, tp3.price ?? mainExitPrice ?? params.entryPrice, fallbackTp4)
  const stopPlan = selectLongStopPlan({
    bars15m: params.bars15m,
    sweepIndex: params.sweepIndex,
    bosIndex: params.bosIndex,
    reactionIndex: params.reactionIndex,
    entryPrice: params.entryPrice,
    structuralStop: params.stopLoss,
    atr15m: params.atr15m,
    policy: params.policy,
  })
  return {
    mode: 'structure_first_trailing_v1',
    tp1: {
      price: tp1Price,
      source: priorHigh != null
        ? '15m_previous_high'
        : tp1Vwap != null
          ? 'vwap_fair_value'
          : fallbackTp1 != null
            ? 'r_multiple_fallback'
            : 'unavailable',
      action: 'partial_take_profit',
    },
    mainExit: {
      price: mainExitPrice,
      zoneLow: price(supplyLow),
      zoneHigh: price(supplyHigh),
      source: supplyExit != null
        ? '1h_supply_zone'
        : mainExitCandidate.source === '15m_previous_high'
          ? 'tp_ladder'
          : mainExitCandidate.source,
      action: 'main_take_profit',
    },
    tp3: {
      price: tp3.price,
      source: tp3.source === '15m_previous_high' ? 'tp_ladder' : tp3.source,
      action: 'extended_take_profit',
    },
    tp4: {
      price: tp4.price,
      source: tp4.source === '15m_previous_high' ? 'tp_ladder' : tp4.source,
      action: 'extended_take_profit',
    },
    manualTp: {
      price: null,
      source: 'unavailable',
      action: 'manual_take_profit',
    },
    trailingStop: {
      initial: price(stopPlan.price),
      method: stopPlan.method,
      source: stopPlan.source,
      activation: 'after_tp1_or_reverse_choch',
    },
    reverseWarning: {
      state: params.bearishDefense.state,
      action: params.bearishDefense.ready ? 'EXIT_ON_REVERSE_BOS' : params.bearishDefense.action,
      source: 'bearish_defense_sidecar',
    },
  }
}

function scanLongSequence(params: {
  input: S12IntradayInput
  bars15m: S12Bar[]
  completedBars: S12IntradayAssessment['completedBars']
  bias4h: S12Bias4h
  bias1h: S12HtfBias
  demandZone1h: S12IntradayZone
  supplyZone1h: S12IntradayZone | null
  bearishDefense: S12BearishDefense
  quality: S12StructureQuality
  policy: S12TimingPolicy
}): S12IntradayAssessment {
  const { input, bars15m, completedBars, bias4h, bias1h, demandZone1h, supplyZone1h, bearishDefense, quality, policy } = params
  const context = { bias1h, supplyZone1h, bearishDefense, quality }
  const atr15m = averageTrueRange(bars15m, policy.atr15mBars) ?? Math.max(0.01, bars15m[bars15m.length - 1].high - bars15m[bars15m.length - 1].low)
  const eligibleBars = bars15m.filter((bar) => bar.startMs >= demandZone1h.createdMs)
  const offset = bars15m.length - eligibleBars.length
  const zoneTouchStaleBars = policy.zoneTouchStaleBars
  const touchRelative = eligibleBars.findIndex((bar) => overlapsZone(bar, demandZone1h))
  if (touchRelative < 0) {
    return completeAssessment({
      input,
      state: 'waiting_15m_zone_touch',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: {},
      execution: { atr15m },
      extraDetail: eligibleBars.length > zoneTouchStaleBars
        ? {
          stale: 'true',
          stale_reason: '15m_zone_touch_timeout',
          stale_after_15m_bars: zoneTouchStaleBars,
          elapsed_15m_bars: eligibleBars.length,
        }
        : { elapsed_15m_bars: eligibleBars.length },
    })
  }
  const touchIndex = offset + touchRelative
  const touch = bars15m[touchIndex]

  const latest = bars15m[bars15m.length - 1]
  if (latest.startMs >= touch.startMs && latest.close < demandZone1h.low - atr15m * 0.1) {
    return completeAssessment({
      input,
      state: 'invalidated',
      reason: 's12_structure_invalidated',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs },
      execution: { atr15m },
      setupId: setupKey(input.symbol, touch.startMs),
      extraDetail: { invalidated_by: '15m_close_below_1h_demand' },
    })
  }

  let sweepIndex = -1
  const sweepEnd = Math.min(bars15m.length - 1, touchIndex + policy.sweepWaitBars)
  for (let i = touchIndex; i <= sweepEnd; i += 1) {
    const priorLow = lowBetween(bars15m, Math.max(0, i - policy.swingLookbackBars), i)
    if (priorLow == null) continue
    const bar = bars15m[i]
    const priorDown = bars15m.slice(Math.max(0, i - policy.priorDirectionalBars), i).some((candidate) => candidate.close < candidate.open)
    const reclaimed = bar.close > Math.max(demandZone1h.low, bar.low + atr15m * 0.12)
    if (priorDown && bar.low < priorLow && reclaimed && bar.low <= demandZone1h.high) {
      sweepIndex = i
      break
    }
  }
  if (sweepIndex < 0) {
    const elapsedBars = Math.max(0, bars15m.length - 1 - touchIndex)
    const stale = bars15m.length - 1 > sweepEnd
    const entryPrice = latest.close
    const stopLoss = Math.max(0.01, Math.min(touch.low, demandZone1h.low) - atr15m * 0.1)
    return completeAssessment({
      input,
      state: 'waiting_sweep',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs },
      execution: {
        entryPrice,
        chaseCeiling: entryPrice + atr15m * 0.2,
        stopLoss,
        atr15m,
        rMultiple: entryPrice > stopLoss ? (entryPrice - stopLoss) / atr15m : null,
      },
      setupId: setupKey(input.symbol, touch.startMs),
      extraDetail: stale
        ? {
          stale: 'true',
          stale_reason: 'sweep_timeout',
          stale_after_15m_bars: policy.sweepWaitBars,
          elapsed_15m_bars: elapsedBars,
        }
        : { elapsed_15m_bars: elapsedBars },
    })
  }
  const sweep = bars15m[sweepIndex]

  let chochIndex = -1
  const chochLevel = highBetween(bars15m, Math.max(0, sweepIndex - policy.swingLookbackBars), sweepIndex + 1)
  const chochEnd = Math.min(bars15m.length - 1, sweepIndex + policy.chochWaitBars)
  for (let i = sweepIndex + 1; i <= chochEnd; i += 1) {
    const bar = bars15m[i]
    const body = Math.abs(bar.close - bar.open)
    if (chochLevel != null && bar.close > chochLevel && bar.close > bar.open && body >= atr15m * 0.08) {
      chochIndex = i
      break
    }
  }
  if (chochIndex < 0) {
    const elapsedBars = Math.max(0, bars15m.length - 1 - sweepIndex)
    const stale = bars15m.length - 1 > chochEnd
    const entryPrice = latest.close
    const stopLoss = Math.max(0.01, Math.min(sweep.low, demandZone1h.low) - atr15m * 0.1)
    return completeAssessment({
      input,
      state: 'waiting_choch',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs },
      execution: {
        entryPrice,
        chaseCeiling: entryPrice + atr15m * 0.22,
        stopLoss,
        atr15m,
        rMultiple: entryPrice > stopLoss ? (entryPrice - stopLoss) / atr15m : null,
      },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs),
      extraDetail: stale
        ? {
          stale: 'true',
          stale_reason: 'choch_timeout',
          stale_after_15m_bars: policy.chochWaitBars,
          elapsed_15m_bars: elapsedBars,
        }
        : { elapsed_15m_bars: elapsedBars },
    })
  }
  const choch = bars15m[chochIndex]

  let bosIndex = -1
  const bosLevel = highBetween(bars15m, touchIndex, chochIndex + 1)
  const bosEnd = Math.min(bars15m.length - 1, chochIndex + policy.bosWaitBars)
  for (let i = chochIndex + 1; i <= bosEnd; i += 1) {
    const bar = bars15m[i]
    const higherLow = lowBetween(bars15m, chochIndex + 1, i + 1)
    if (bosLevel != null && bar.close > bosLevel && (higherLow == null || higherLow > sweep.low)) {
      bosIndex = i
      break
    }
  }
  if (bosIndex < 0) {
    const elapsedBars = Math.max(0, bars15m.length - 1 - chochIndex)
    const stale = bars15m.length - 1 > bosEnd
    const entryPrice = latest.close
    const stopLoss = Math.max(0.01, Math.min(sweep.low, demandZone1h.low) - atr15m * 0.1)
    return completeAssessment({
      input,
      state: 'waiting_bos',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs, chochMs: choch.startMs },
      execution: {
        entryPrice,
        chaseCeiling: entryPrice + atr15m * 0.25,
        stopLoss,
        atr15m,
        rMultiple: entryPrice > stopLoss ? (entryPrice - stopLoss) / atr15m : null,
      },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs, choch.startMs),
      extraDetail: stale
        ? {
          stale: 'true',
          stale_reason: 'bos_timeout',
          stale_after_15m_bars: policy.bosWaitBars,
          elapsed_15m_bars: elapsedBars,
        }
        : { elapsed_15m_bars: elapsedBars },
    })
  }
  const bos = bars15m[bosIndex]
  const ob = lastBearishBar(bars15m, chochIndex, bosIndex) ?? sweep
  const entryZone = {
    low: Math.min(ob.low, ob.close),
    high: Math.max(ob.open, ob.close),
  }
  const overlapLow = Math.max(entryZone.low, demandZone1h.low)
  const overlapHigh = Math.min(entryZone.high, demandZone1h.high)
  if (overlapLow > overlapHigh) {
    return completeAssessment({
      input,
      state: 'invalidated',
      reason: 's12_entry_zone_not_overlapping_1h_demand',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs, chochMs: choch.startMs, bosMs: bos.startMs },
      execution: { atr15m },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs, choch.startMs, bos.startMs),
      extraDetail: {
        entry_zone_low: price(entryZone.low),
        entry_zone_high: price(entryZone.high),
      },
    })
  }

  let retestIndex = -1
  let reactionIndex = -1
  const retestEnd = Math.min(bars15m.length - 1, bosIndex + policy.retestWaitBars)
  for (let i = bosIndex + 1; i <= retestEnd; i += 1) {
    const bar = bars15m[i]
    const retest = bar.low <= entryZone.high && bar.high >= entryZone.low
    if (retest && retestIndex < 0) retestIndex = i
    const reaction = retest && bar.close > bar.open && bar.close >= Math.min(entryZone.high, bar.open + atr15m * 0.08)
    if (reaction) {
      reactionIndex = i
      break
    }
  }
  if (reactionIndex < 0) {
    const elapsedBars = Math.max(0, bars15m.length - 1 - bosIndex)
    const stale = bars15m.length - 1 > retestEnd
    const entryPrice = latest.close
    const stopLoss = Math.max(0.01, Math.min(sweep.low, entryZone.low) - atr15m * 0.1)
    return completeAssessment({
      input,
      state: retestIndex >= 0 ? 'waiting_reaction' : 'waiting_retest',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: {
        zoneTouchMs: touch.startMs,
        sweepMs: sweep.startMs,
        chochMs: choch.startMs,
        bosMs: bos.startMs,
        retestMs: retestIndex >= 0 ? bars15m[retestIndex].startMs : null,
      },
      execution: {
        entryPrice,
        chaseCeiling: entryPrice + atr15m * 0.25,
        stopLoss,
        atr15m,
        rMultiple: entryPrice > stopLoss ? (entryPrice - stopLoss) / atr15m : null,
      },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs, choch.startMs, bos.startMs),
      extraDetail: {
        entry_zone_low: price(entryZone.low),
        entry_zone_high: price(entryZone.high),
        retest_accepted: retestIndex >= 0 ? 'true' : 'false',
        stale: stale ? 'true' : null,
        stale_reason: stale ? (retestIndex >= 0 ? 'reaction_timeout' : 'retest_timeout') : null,
        stale_after_15m_bars: policy.retestWaitBars,
        elapsed_15m_bars: elapsedBars,
      },
    })
  }

  const reaction = bars15m[reactionIndex]
  const entryPrice = reaction.close
  const stopLoss = Math.min(sweep.low, entryZone.low) - atr15m * 0.1
  const risk = entryPrice - stopLoss
  const exitPlan = buildLongExitPlan({
    bars15m,
    touchIndex,
    sweepIndex,
    bosIndex,
    reactionIndex,
    entryPrice,
    stopLoss,
    atr15m,
    risk,
    supplyZone1h,
    bearishDefense,
    quality,
    policy,
  })
  const effectiveStopLoss = exitPlan.trailingStop.initial ?? stopLoss
  const effectiveRisk = entryPrice - effectiveStopLoss
  if (effectiveRisk <= 0 || effectiveRisk > atr15m * 3) {
    return completeAssessment({
      input,
      state: 'invalidated',
      reason: 's12_invalid_risk_box',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: {
        zoneTouchMs: touch.startMs,
        sweepMs: sweep.startMs,
        chochMs: choch.startMs,
        bosMs: bos.startMs,
        retestMs: reaction.startMs,
        reactionMs: reaction.startMs,
      },
      execution: {
        entryPrice,
        chaseCeiling: entryPrice + atr15m * 0.25,
        stopLoss: effectiveStopLoss,
        atr15m,
        rMultiple: effectiveRisk / atr15m,
      },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs, choch.startMs, bos.startMs, reaction.startMs),
    })
  }

  return completeAssessment({
    input,
    state: 'reaction_ready',
    completedBars,
    bias4h,
    ...context,
    demandZone1h,
    exitPlan,
    sequence: {
      zoneTouchMs: touch.startMs,
      sweepMs: sweep.startMs,
      chochMs: choch.startMs,
      bosMs: bos.startMs,
      retestMs: reaction.startMs,
      reactionMs: reaction.startMs,
    },
    execution: {
      entryPrice,
      chaseCeiling: entryPrice + atr15m * 0.25,
      stopLoss: effectiveStopLoss,
      target1: exitPlan.tp1.price,
      target2: exitPlan.mainExit.price,
      target3: exitPlan.tp3.price,
      target4: exitPlan.tp4.price,
      atr15m,
      rMultiple: effectiveRisk / atr15m,
    },
    setupId: setupKey(input.symbol, touch.startMs, sweep.startMs, choch.startMs, bos.startMs, reaction.startMs),
    extraDetail: {
      entry_zone_low: price(entryZone.low),
      entry_zone_high: price(entryZone.high),
    },
  })
}

export function assessS12IntradayStructure(input: S12IntradayInput): S12IntradayAssessment {
  const bars15m = normalizeBars(input.bars15m)
  const fallback15mBars = normalizeBars(input.fallback15mBars ?? [])
  const context15mBars = [...fallback15mBars, ...bars15m].sort((a, b) => a.startMs - b.startMs)
  const bars1h = normalizeBars(input.bars1h)
  const barsSession60 = normalizeBars(input.barsSession60 ?? input.bars4h ?? [])
  const bars1d = normalizeBars(input.bars1d ?? [])
  const fallback1hBars = normalizeBars(input.fallback1hBars ?? [])
  const completedBars = { m15: bars15m.length, h1: bars1h.length, session60: barsSession60.length, h4: barsSession60.length }
  const policy = inputTimingPolicy(input)
  const currentSupplyZone1h = bars1h.length > 0 ? findSupplyZone1h(bars1h, policy) : null
  const fallbackSupplyZone1h = !currentSupplyZone1h && fallback1hBars.length > 0 ? findSupplyZone1h(fallback1hBars, policy) : null
  const currentDemandZone1h = bars1h.length > 0 ? findDemandZone1h(bars1h, policy) : null
  const fallbackDemandZone1h = !currentDemandZone1h && fallback1hBars.length > 0 ? findDemandZone1h(fallback1hBars, policy) : null
  const previousSession1hSeedCandidate = Boolean(
    (!currentDemandZone1h && fallbackDemandZone1h) ||
    (!currentSupplyZone1h && fallbackSupplyZone1h),
  )
  const effectiveMin15mBars = effectiveMin15mBarsForSeed(policy, previousSession1hSeedCandidate)
  const context15mCount = Math.max(bars15m.length, context15mBars.length)
  if (bars15m.length < 1 || context15mCount < effectiveMin15mBars) {
    return emptyAssessment(input, 'waiting_15m_completed_bars', 's12_waiting_15m_completed_bars', {
      bars15m: bars15m.length,
      current_session_15m_bars: bars15m.length,
      previous_session_15m_seed_bars: fallback15mBars.length,
      seeded_context_15m_bars: context15mBars.length,
      min15mBars: policy.min15mBars,
      effective_min15m_bars: effectiveMin15mBars,
      previous_session_1h_seed_candidate: previousSession1hSeedCandidate ? 'true' : 'false',
      fallback_1h_completed_bars: fallback1hBars.length,
      demand_zone_source: currentDemandZone1h ? 'current_session_1h' : fallbackDemandZone1h ? 'previous_session_1h' : null,
      supply_zone_source: currentSupplyZone1h ? 'current_session_1h' : fallbackSupplyZone1h ? 'previous_session_1h' : null,
    }, completedBars)
  }
  if (barsSession60.length < 1) {
    return emptyAssessment(input, 'waiting_session_60m_completed_bar', 's12_waiting_session_60m_completed_bar', completedBars, completedBars)
  }
  const bias4h = resolve4hBias(barsSession60, policy)
  const neutral1hBias: S12HtfBias = { direction: 'neutral', confidence: 'none', channelAlign: false }
  const bias1h = bars1h.length > 0 ? resolve1hBias(bars1h, policy) : neutral1hBias
  const supplyZone1h = currentSupplyZone1h ?? fallbackSupplyZone1h
  const demandZone1h = currentDemandZone1h ?? fallbackDemandZone1h
  const parityDiagnostics = zoneLifecycleDiagnostics({ demandZone1h, supplyZone1h, bars15m: context15mBars, bars1h, bars4h: barsSession60, bars1d, policy })
  const inputWithZoneDiagnostics: S12IntradayInput = {
    ...input,
    barDiagnostics: {
      ...(input.barDiagnostics ?? {}),
      current_session_15m_bars: bars15m.length,
      previous_session_15m_seed_bars: fallback15mBars.length,
      seeded_context_15m_bars: context15mBars.length,
      fallback_1h_completed_bars: fallback1hBars.length,
      effective_min15m_bars: effectiveMin15mBars,
      previous_session_1h_seed_candidate: previousSession1hSeedCandidate ? 'true' : 'false',
      demand_zone_source: currentDemandZone1h ? 'current_session_1h' : fallbackDemandZone1h ? 'previous_session_1h' : null,
      supply_zone_source: currentSupplyZone1h ? 'current_session_1h' : fallbackSupplyZone1h ? 'previous_session_1h' : null,
      position_planned_tp: policy.plannedTakeProfit,
      manual_tp_price: null,
      ...parityDiagnostics,
    },
  }
  const bearishDefense = scanBearishDefenseSequence({ input: inputWithZoneDiagnostics, bars15m, supplyZone1h, policy })
  const quality = buildStructureQuality(context15mBars, policy, { bars1h, bars4h: barsSession60, bars1d })
  const equityMutation = buildEquityMutationContext({
    bars15m: context15mBars,
    bias4h,
    bias1h,
    quality,
    policy,
  })

  if (bearishDefense.ready) {
    return completeAssessment({
      input: inputWithZoneDiagnostics,
      state: 'bearish_defense_ready',
      reason: bearishDefense.reason,
      completedBars,
      bias4h,
      bias1h,
      demandZone1h,
      supplyZone1h,
      bearishDefense,
      quality,
      sequence: {},
      setupId: setupKey(input.symbol, bearishDefense.sequence.zoneTouchMs, bearishDefense.sequence.sweepMs, bearishDefense.sequence.chochMs, bearishDefense.sequence.bosMs, bearishDefense.sequence.reactionMs),
      extraDetail: {
        defensive_action: 'NO_BUY',
        defensive_use: 'pending_buy_no_buy_only_no_short_order',
      },
    })
  }

  const sessionContextSource = input.sessionContextSource ?? (
    input.h4Source === 'previous_trading_day_fallback'
      ? 'previous_session_60m'
      : completedBars.session60 > 0
        ? 'current_session_60m'
        : 'unavailable'
  )
  if (shouldBlockOnSession60BearishRisk(sessionContextSource, bias4h)) {
    return completeAssessment({
      input: inputWithZoneDiagnostics,
      state: 'waiting_session_60m_bearish_risk',
      completedBars,
      bias4h,
      bias1h,
      demandZone1h: null,
      supplyZone1h,
      bearishDefense,
      quality,
      sequence: {},
      extraDetail: {
        latest_session_60m_close: price(barsSession60[barsSession60.length - 1]?.close),
        required: 'session_60m_not_confirmed_short',
        session_60m_bias_gate: 'confirmed_short_only',
        equity_mutation_context: 'false',
        equity_mutation_score: equityMutation.score,
        equity_mutation_reasons: equityMutation.reasons.join('|'),
        equity_mutation_risk_haircuts: equityMutation.riskHaircuts.join('|'),
        vwap_fast_acceptance: String(equityMutation.vwapFastAcceptance),
        vwap_fast_reasons: equityMutation.vwapFastReasons.join('|'),
        vwap_slow_context: equityMutation.vwapSlowContext,
        htf_hard_block: String(equityMutation.htfHardBlock),
      },
    })
  }
  if (equityMutation.active) {
    if (demandZone1h) {
      const strictSequence = scanLongSequence({
        input: inputWithZoneDiagnostics,
        bars15m,
        completedBars,
        bias4h,
        bias1h,
        demandZone1h,
        supplyZone1h,
        bearishDefense,
        quality,
        policy,
      })
      if (strictSequence.state === 'reaction_ready') return strictSequence
    }
    return completeEquityMutationAssessment({
      input: inputWithZoneDiagnostics,
      bars15m: context15mBars,
      completedBars,
      bias4h,
      bias1h,
      supplyZone1h,
      bearishDefense,
      quality,
      mutation: equityMutation,
      policy,
    })
  }
  if (bars1h.length < 1 && fallback1hBars.length < 1) {
    return completeAssessment({
      input: inputWithZoneDiagnostics,
      state: 'waiting_1h_completed_bar',
      completedBars,
      bias4h,
      bias1h,
      demandZone1h: null,
      supplyZone1h,
      bearishDefense,
      quality,
      sequence: {},
      extraDetail: {
        equity_mutation_context: 'false',
        equity_mutation_score: equityMutation.score,
        equity_mutation_reasons: equityMutation.reasons.join('|'),
        equity_mutation_risk_haircuts: equityMutation.riskHaircuts.join('|'),
        vwap_fast_acceptance: String(equityMutation.vwapFastAcceptance),
        vwap_fast_reasons: equityMutation.vwapFastReasons.join('|'),
        vwap_slow_context: equityMutation.vwapSlowContext,
        htf_hard_block: String(equityMutation.htfHardBlock),
        one_h_demand_required: 'true',
        one_h_demand_role: 'hard_gate_until_equity_mutation_context',
      },
    })
  }
  if (!demandZone1h) {
    return completeAssessment({
      input: inputWithZoneDiagnostics,
      state: 'waiting_1h_demand_zone',
      completedBars,
      bias4h,
      bias1h,
      demandZone1h: null,
      supplyZone1h,
      bearishDefense,
      quality,
      sequence: {},
      extraDetail: {
        equity_mutation_context: 'false',
        equity_mutation_score: equityMutation.score,
        equity_mutation_reasons: equityMutation.reasons.join('|'),
        equity_mutation_risk_haircuts: equityMutation.riskHaircuts.join('|'),
        vwap_fast_acceptance: String(equityMutation.vwapFastAcceptance),
        vwap_fast_reasons: equityMutation.vwapFastReasons.join('|'),
        vwap_slow_context: equityMutation.vwapSlowContext,
        htf_hard_block: String(equityMutation.htfHardBlock),
        one_h_demand_required: 'true',
        one_h_demand_role: 'hard_gate_until_equity_mutation_context',
      },
    })
  }
  return scanLongSequence({ input: inputWithZoneDiagnostics, bars15m, completedBars, bias4h, bias1h, demandZone1h, supplyZone1h, bearishDefense, quality, policy })
}

export function assessS12IntradayStructureFromBaseBars(input: S12FromBaseBarsInput): S12IntradayAssessment {
  const nowMs = input.nowMs ?? Date.now()
  const currentSession15m = aggregateCompletedS12Bars(input.baseBars, M15_MS, nowMs, { alignToTwSession: true })
  const fallback15m = aggregateCompletedS12Bars(input.fallback15mBars ?? [], M15_MS, nowMs, { alignToTwSession: true })
  const bars1h = aggregateCompletedS12Bars(input.baseBars, H1_MS, nowMs, { alignToTwSession: true })
  const fallback1h = aggregateCompletedS12Bars(input.fallback1hBars ?? [], H1_MS, nowMs, { alignToTwSession: true })
  const session60Bars = bars1h.length > 0 ? bars1h : fallback1h
  const sessionContextSource: S12IntradayAssessment['sessionContextSource'] = bars1h.length > 0
    ? 'current_session_60m'
    : fallback1h.length > 0
      ? 'previous_session_60m'
      : 'unavailable'
  const dailyContext = normalizeBars(input.fallbackDailyBars ?? [])
  const bars1d = dailyContext.length > 0
    ? dailyContext
    : aggregateTwDailyS12Bars([...(input.fallback1hBars ?? []), ...(input.fallback15mBars ?? []), ...input.baseBars], nowMs)
  const h4Source: S12H4Source = sessionContextSource === 'current_session_60m'
    ? 'current_session'
    : sessionContextSource === 'previous_session_60m'
      ? 'previous_trading_day_fallback'
      : 'unavailable'
  return assessS12IntradayStructure({
    symbol: input.symbol,
    nowMs,
    bars15m: currentSession15m,
    bars1h,
    barsSession60: session60Bars,
    bars1d,
    fallback15mBars: fallback15m,
    fallback1hBars: fallback1h,
    h4Source,
    sessionContextSource,
    h4ReferenceDate: h4Source === 'previous_trading_day_fallback' ? input.h4ReferenceDate ?? null : null,
    h4ReferenceClose: h4Source === 'previous_trading_day_fallback' ? input.h4ReferenceClose ?? null : null,
    policy: input.policy,
    barDiagnostics: {
      ...(input.barDiagnostics ?? {}),
      ...sessionAggregationDiagnostics(input.baseBars, nowMs),
      completed_15m_bars: currentSession15m.length,
      completed_15m_current_session_bars: currentSession15m.length,
      completed_15m_seeded_context_bars: fallback15m.length,
      completed_1h_bars: bars1h.length,
      completed_session_60m_current_bars: bars1h.length,
      completed_session_60m_fallback_bars: fallback1h.length,
      context_timeframe: 'tw_equity_session_60m',
      legacy_4h_proxy_disabled: 'true',
      completed_1h_fallback_bars: fallback1h.length,
      completed_1d_proxy_bars: bars1d.length,
    },
  })
}

export type S12IntradayGateMode = 'observe' | 'block_invalidated' | 'require_ready' | 'assist_entry'

export function s12PreTradeTechnicalDecision(
  assessment: S12IntradayAssessment,
  mode: S12IntradayGateMode = 'observe',
): { action: 'pass' | 'defer' | 'skip'; reason: string; detail: string } | null {
  if (mode === 'observe') return null
  if (assessment.defensiveAction === 'NO_BUY' || assessment.state === 'bearish_defense_ready') {
    return { action: 'skip', reason: 's12_bearish_defense_ready', detail: assessment.detail }
  }
  if (assessment.invalidated) {
    return { action: 'skip', reason: assessment.reason, detail: assessment.detail }
  }
  const longEntryReady = assessment.ready && assessment.maturity.takeoverRole === 'long_entry'
  if (mode === 'require_ready' && !longEntryReady) {
    return { action: 'defer', reason: assessment.reason, detail: assessment.detail }
  }
  if ((mode === 'require_ready' || mode === 'assist_entry') && longEntryReady) {
    return { action: 'pass', reason: assessment.reason, detail: assessment.detail }
  }
  return null
}

export function isS12ExecutableLongAssessment(assessment: S12IntradayAssessment | null | undefined): boolean {
  return Boolean(assessment?.ready && assessment.maturity.takeoverRole === 'long_entry')
}

export function isS12HardVetoAssessment(assessment: S12IntradayAssessment | null | undefined): boolean {
  if (!assessment) return false
  return Boolean(
    assessment.invalidated ||
      assessment.state === 'invalidated' ||
      assessment.state === 'bearish_defense_ready' ||
      assessment.defensiveAction === 'NO_BUY' ||
      assessment.maturity.takeoverRole === 'invalidate' ||
      assessment.maturity.takeoverRole === 'no_buy_defense',
  )
}

export function isS12PrimaryOwnerBlockingAssessment(assessment: S12IntradayAssessment | null | undefined): boolean {
  return isS12ExecutableLongAssessment(assessment) || isS12HardVetoAssessment(assessment)
}

export function resolveS12UnifiedDecision(
  assessment: S12IntradayAssessment | null,
): S12UnifiedDecision {
  if (!assessment) {
    return {
      action: 'WAIT',
      reason: 's12_data_unavailable',
      detail: s12DecisionDetail({ reason: 's12_data_unavailable' }),
      stage: 'data',
      role: 'none',
      source: 's12_intraday_structure_v1',
      executableBookRequired: false,
      noShortOrder: true,
      s12State: null,
      setupId: null,
    }
  }
  if (assessment.defensiveAction === 'NO_BUY' || assessment.state === 'bearish_defense_ready') {
    return {
      action: 'NO_BUY',
      reason: 's12_bearish_defense_ready',
      detail: assessment.detail,
      stage: assessment.maturity.stage,
      role: 'no_buy_defense',
      source: 's12_intraday_structure_v1',
      executableBookRequired: false,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
    }
  }
  if (assessment.invalidated) {
    return {
      action: 'INVALIDATED',
      reason: assessment.reason,
      detail: assessment.detail,
      stage: assessment.maturity.stage,
      role: 'invalidate',
      source: 's12_intraday_structure_v1',
      executableBookRequired: false,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
    }
  }
  if (assessment.ready && assessment.maturity.takeoverRole === 'long_entry') {
    return {
      action: 'READY',
      reason: assessment.reason,
      detail: assessment.detail,
      stage: assessment.maturity.stage,
      role: 'long_entry',
      source: 's12_intraday_structure_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      targetPrice: assessment.execution.entryPrice ?? null,
      stopPrice: assessment.execution.stopLoss ?? null,
    }
  }
  return {
    action: assessment.maturity.stale ? 'DEFER' : 'WAIT',
    reason: assessment.reason,
    detail: assessment.detail,
    stage: assessment.maturity.stage,
    role: assessment.maturity.takeoverRole,
    source: 's12_intraday_structure_v1',
    executableBookRequired: false,
    noShortOrder: true,
    s12State: assessment.state,
    setupId: assessment.setupId,
  }
}

export function resolveS12PositionDecision(input: S12PositionDecisionInput): S12UnifiedDecision {
  const assessment = input.assessment
  const entryPrice = finitePositive(input.pos.entry_price) ?? finitePositive(input.pos.avg_cost)
  const currentPrice = finitePositive(input.currentPrice)
  const shares = Math.floor(finitePositive(input.pos.shares) ?? 0)
  const originalShares = Math.floor(finitePositive(input.pos.original_shares) ?? shares)
  const positionTp1 = finitePositive(input.pos.tp1_price)
  const assessmentTp1 = finitePositive(assessment?.exitPlan?.tp1?.price)
  const assessmentMainExit = finitePositive(assessment?.exitPlan?.mainExit?.price)
  const positionTp1Source =
    input.pos.tp1_source != null
      ? String(input.pos.tp1_source)
      : input.pos.fusion_runner_tp1_source != null
        ? String(input.pos.fusion_runner_tp1_source)
        : input.pos.s12_tp1_source != null
          ? String(input.pos.s12_tp1_source)
        : null
  const assessmentTp1Source = assessment?.exitPlan?.tp1?.source === 'unavailable'
    ? null
    : assessment?.exitPlan?.tp1?.source ?? null
  const persistedPressureTp1 = finitePositive(input.pos.s12_pressure_tp1)
  const pressureTp1 = assessmentTp1 ?? persistedPressureTp1
  const pressureTp1Source = assessmentTp1 != null
    ? assessmentTp1Source
    : input.pos.s12_pressure_tp1_source != null
      ? String(input.pos.s12_pressure_tp1_source)
      : input.pos.s12_tp1_source != null
        ? String(input.pos.s12_tp1_source)
        : null
  const fusionRunnerTp1 = finitePositive(input.pos.fusion_runner_tp1) ?? positionTp1
  const assessmentMainExitSource =
    input.pos.s12_main_exit_source != null
      ? String(input.pos.s12_main_exit_source)
      : assessment?.exitPlan?.mainExit?.source === 'unavailable'
        ? null
        : assessment?.exitPlan?.mainExit?.source ?? null
  const tp1 = positionTp1 ?? assessmentTp1
  const tp2 = finitePositive(input.pos.tp2_price) ?? assessmentMainExit
  const tp3 = finitePositive(input.pos.tp3_price) ?? finitePositive(assessment?.exitPlan?.tp3?.price)
  const tp4 = finitePositive(input.pos.tp4_price) ?? finitePositive(assessment?.exitPlan?.tp4?.price)
  const plannedTp = normalizePlannedTakeProfit(input.pos.planned_take_profit ?? assessment?.barDiagnostics?.position_planned_tp ?? 'tp2')
  const plannedExitTarget =
    plannedTp === 'tp4'
      ? tp4 ?? tp3 ?? tp2
      : plannedTp === 'tp3'
        ? tp3 ?? tp2
        : tp2
  const positionStructuralStop = finitePositive(input.pos.s12_position_stop_price)
  const positionStructuralSource = input.pos.s12_position_stop_source != null
    ? String(input.pos.s12_position_stop_source)
    : null
  const positionStructuralMethod = input.pos.s12_position_stop_method != null
    ? String(input.pos.s12_position_stop_method)
    : null
  const assessmentStructuralStop =
    finitePositive(assessment?.exitPlan?.trailingStop?.initial) ??
    finitePositive(assessment?.execution?.stopLoss)
  const s12StructuralStopCandidates = [
    positionStructuralStop,
    assessmentStructuralStop,
  ].filter((value): value is number => value != null)
  const s12StructuralStop = s12StructuralStopCandidates.length > 0
    ? Math.max(...s12StructuralStopCandidates)
    : null
  const structuralStopFromAssessment =
    assessmentStructuralStop != null &&
    s12StructuralStop === assessmentStructuralStop &&
    (positionStructuralStop == null || assessmentStructuralStop > positionStructuralStop)
  const structuralStopSource = structuralStopFromAssessment
    ? assessment?.exitPlan?.trailingStop?.source ?? 's12_assessment_stop'
    : positionStructuralSource ?? assessment?.exitPlan?.trailingStop?.source ?? null
  const structuralStopMethod = structuralStopFromAssessment
    ? assessment?.exitPlan?.trailingStop?.method ?? 's12_assessment_stop_loss'
    : positionStructuralMethod ?? assessment?.exitPlan?.trailingStop?.method ?? null
  const structuralStop =
    s12StructuralStop ??
    finitePositive(input.pos.initial_stop) ??
    finitePositive(input.pos.trailing_stop)
  const vwapContext = assessment?.quality?.vwapContext
  const atr = finitePositive(input.atr14) ?? (currentPrice != null ? currentPrice * 0.02 : null)
  const baseDetail = {
    source: 's12_position_decision_v1',
    state: assessment?.state ?? null,
    setup_id: assessment?.setupId ?? null,
    current_price: price(currentPrice),
    entry_price: price(entryPrice),
    tp1: price(tp1),
    tp2: price(tp2),
    tp3: price(tp3),
    tp4: price(tp4),
    assessment_tp1: price(assessmentTp1),
    assessment_main_exit: price(assessmentMainExit),
    manual_tp: null,
    planned_take_profit: plannedTp,
    planned_exit_target: price(plannedExitTarget),
    structural_stop: price(structuralStop),
    position_structural_stop: price(positionStructuralStop),
    assessment_structural_stop: price(assessmentStructuralStop),
    structural_stop_source: structuralStopSource,
    structural_stop_method: structuralStopMethod,
    structural_stop_no_atr_buffer: s12StructuralStop != null ? 'true' : null,
    exit_fusion_policy: 'tw_equity_exit_fusion_v2',
    tp_fusion_policy: 'tw_equity_exit_fusion_v2',
    position_opened_today: input.pos.position_opened_today === true ? 'true' : 'false',
    active_tp1_source: positionTp1 != null ? 'position_lifecycle' : assessmentTp1 != null ? 's12_assessment' : null,
    position_tp1_source: positionTp1Source,
    assessment_tp1_source: assessmentTp1Source,
    near_pressure_tp1: price(pressureTp1),
    near_pressure_tp1_source: pressureTp1Source,
    fusion_runner_tp1: price(fusionRunnerTp1),
    fusion_runner_tp1_source: positionTp1Source,
    assessment_main_exit_source: assessmentMainExitSource,
    vwap_state: assessment?.quality?.vwap?.state ?? null,
    vwap_stack: vwapContext?.stackState ?? null,
    vwap_nearest_above: price(vwapContext?.nearestAbove?.price),
    vwap_nearest_above_source: vwapContext?.nearestAbove?.source ?? null,
    vwap_nearest_below: price(vwapContext?.nearestBelow?.price),
    vwap_nearest_below_source: vwapContext?.nearestBelow?.source ?? null,
    ib_state: vwapContext?.initialBalance?.state ?? null,
    rvol: assessment?.quality?.rvol?.value ?? null,
    rvol_state: assessment?.quality?.rvol?.state ?? null,
    position_exit_policy: 'independent_of_long_entry_readiness',
    executable_book_available: input.executableBookAvailable ? 'true' : 'false',
    no_short_order: 'true',
  }

  const wait = (reason = assessment?.reason ?? 's12_position_wait'): S12UnifiedDecision => ({
    action: 'WAIT',
    reason,
    detail: s12DecisionDetail(baseDetail),
    stage: assessment?.maturity.stage ?? 'data',
    role: 'position_exit',
    source: 's12_position_decision_v1',
    executableBookRequired: false,
    noShortOrder: true,
    s12State: assessment?.state ?? null,
    setupId: assessment?.setupId ?? null,
  })

  if (!assessment || entryPrice == null || currentPrice == null || shares <= 0) return wait('s12_position_data_unavailable')

  const tp1Hit = Number(input.pos.tp1_hit ?? 0) > 0
  const pnlPct = (currentPrice - entryPrice) / entryPrice
  const dailyWeak = String(assessment.barDiagnostics?.channel_1d_direction ?? '').toLowerCase() === 'short'
  const session60Weak = (assessment.biasSession60 ?? assessment.bias4h)?.direction === 'short'
  const bearishDefenseReady = assessment.bearishDefense.ready || assessment.state === 'bearish_defense_ready'
  const sellRatio = boundedRatio(input.tp1SellRatio, 0.5)
  const tpFusion = resolveTakeProfitFusion({
    entryPrice,
    currentPrice,
    positionTp1,
    pressureTp1,
    runnerTp1: fusionRunnerTp1,
    assessmentMainExit,
    positionTp1Source,
    pressureTp1Source,
    assessmentMainExitSource,
    structuralStop,
    initialStop: finitePositive(input.pos.initial_stop),
    atr,
    tp1Hit,
    openedToday: input.pos.position_opened_today === true,
    bearishDefenseReady,
    dailyWeak,
    session60Weak,
    rvolState: assessment.quality?.rvol?.state,
    vwapStack: vwapContext?.stackState,
    nearestAboveSource: vwapContext?.nearestAbove?.source,
    sellRatio,
  })
  const fusedSellRatio = tpFusion.sellRatio
  const clampedPartial = partialTakeProfitShares({ shares, originalShares, sellRatio: fusedSellRatio })
  const tpFusionDetail = {
    tp_fusion_action: tpFusion.shouldTakeProfit ? 'partial_take_profit' : tpFusion.pressureOnly ? 'tighten_only' : 'none',
    tp_fusion_score: tpFusion.confluenceScore,
    tp_fusion_min_score: tpFusion.minConfluence,
    tp_fusion_profit_r: tpFusion.profitR == null ? null : round(tpFusion.profitR, 3),
    tp_fusion_min_profit_r: tpFusion.minProfitR,
    tp_fusion_gain_pct: round(tpFusion.gainPct, 4),
    tp_fusion_min_gain_pct: tpFusion.minGainPct,
    tp_fusion_pressure_sources: tpFusion.pressureSources.join('|') || null,
    tp_fusion_reasons: tpFusion.reasons.join('|') || null,
    tp_fusion_executable_target: price(tpFusion.executableTarget),
    tp_fusion_executable_target_source: tpFusion.executableTargetSource,
    tp_fusion_near_pressure_target: price(pressureTp1),
    tp_fusion_near_pressure_source: pressureTp1Source,
  }

  if (assessment.invalidated) {
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: 's12_invalidated_defensive_exit_quote_unavailable',
        detail: s12DecisionDetail({ ...baseDetail, trigger: 'invalidated_defensive_exit' }),
        stage: assessment.maturity.stage,
        role: 'position_defense',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
      }
    }
    return {
      action: 'EXIT_ON_REVERSE_BOS',
      reason: 's12_invalidated_defensive_exit',
      detail: s12DecisionDetail({ ...baseDetail, trigger: 'invalidated_defensive_exit', sell_shares: shares }),
      stage: assessment.maturity.stage,
      role: 'position_defense',
      source: 's12_position_decision_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      sellShares: shares,
      sellRatio: 1,
    }
  }

  if (s12StructuralStop != null && structuralStop != null && currentPrice <= structuralStop) {
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: 's12_position_structural_stop_quote_unavailable',
        detail: s12DecisionDetail({ ...baseDetail, trigger: 'position_structural_stop' }),
        stage: assessment.maturity.stage,
        role: 'position_defense',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        stopPrice: structuralStop,
      }
    }
    return {
      action: 'EXIT_ON_REVERSE_BOS',
      reason: 's12_position_structural_stop_full_exit',
      detail: s12DecisionDetail({ ...baseDetail, trigger: 'position_structural_stop', sell_shares: shares }),
      stage: assessment.maturity.stage,
      role: 'position_defense',
      source: 's12_position_decision_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      stopPrice: structuralStop,
      sellShares: shares,
      sellRatio: 1,
    }
  }

  const normalizedPositionTp1Source = String(positionTp1Source ?? '')
  const directTp1Allowed =
    positionTp1 != null &&
    !normalizedPositionTp1Source.startsWith('tw_equity_runner_') &&
    !['15m_previous_high', 'vwap_fair_value', 's12_structure_exit_plan'].includes(normalizedPositionTp1Source)
  const directTp1Touched = !tp1Hit && tp1 != null && currentPrice >= tp1 && directTp1Allowed

  if (tpFusion.pressureOnly && !directTp1Touched) {
    const pressureStop = [
      structuralStop,
      finitePositive(input.pos.trailing_stop),
      finitePositive(input.pos.initial_stop),
      entryPrice,
    ]
      .filter((value): value is number => value != null && value > 0 && value < currentPrice)
      .sort((a, b) => b - a)[0] ?? null
    if (pressureStop != null) {
      return {
        action: 'SET_STRUCTURAL_STOP',
        reason: 's12_position_structural_stop_watch_tp_fusion_pressure',
        detail: s12DecisionDetail({
          ...baseDetail,
          ...tpFusionDetail,
          trigger: 'tp_fusion_pressure_tighten_only',
          stop: pressureStop,
        }),
        stage: assessment.maturity.stage,
        role: 'position_defense',
        source: 's12_position_decision_v1',
        executableBookRequired: false,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        stopPrice: pressureStop,
      }
    }
  }

  if (tpFusion.shouldTakeProfit && tpFusion.executableTarget != null) {
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: 's12_take_profit_fusion_tp1_quote_unavailable',
        detail: s12DecisionDetail({ ...baseDetail, ...tpFusionDetail, trigger: 'tp_fusion_structural_tp1' }),
        stage: assessment.maturity.stage,
        role: 'position_exit',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        targetPrice: tpFusion.executableTarget,
      }
    }
    return {
      action: 'TAKE_PROFIT',
      reason: clampedPartial < shares
        ? 's12_tp_fusion_confluence_partial_take_profit'
        : 's12_tp_fusion_confluence_full_take_profit',
      detail: s12DecisionDetail({
        ...baseDetail,
        ...tpFusionDetail,
        trigger: 'tp_fusion_structural_tp1',
        active_tp1: positionTp1,
        near_pressure_tp1: pressureTp1,
        executable_tp1: tpFusion.executableTarget,
        sell_shares: clampedPartial,
        sell_ratio: fusedSellRatio,
      }),
      stage: assessment.maturity.stage,
      role: 'position_exit',
      source: 's12_position_decision_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      targetPrice: tpFusion.executableTarget,
      sellShares: clampedPartial,
      sellRatio: fusedSellRatio,
    }
  }

  if (directTp1Touched) {
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: 's12_tp1_quote_unavailable',
        detail: s12DecisionDetail({ ...baseDetail, ...tpFusionDetail, trigger: 'tp1' }),
        stage: assessment.maturity.stage,
        role: 'position_exit',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        targetPrice: tp1,
      }
    }
    return {
      action: 'TAKE_PROFIT',
      reason: clampedPartial < shares ? 's12_tp1_partial_take_profit' : 's12_tp1_full_take_profit',
      detail: s12DecisionDetail({ ...baseDetail, ...tpFusionDetail, trigger: 'tp1', sell_shares: clampedPartial, sell_ratio: sellRatio }),
      stage: assessment.maturity.stage,
      role: 'position_exit',
      source: 's12_position_decision_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      targetPrice: tp1,
      sellShares: clampedPartial,
      sellRatio,
    }
  }

  if (tp1Hit && plannedExitTarget != null && currentPrice >= plannedExitTarget) {
    const trigger = plannedTp
    const reason = plannedTp === 'tp4'
      ? 's12_tp4_extended_take_profit'
      : plannedTp === 'tp3'
        ? 's12_tp3_extended_take_profit'
        : 's12_tp2_main_take_profit'
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: `s12_${plannedTp}_quote_unavailable`,
        detail: s12DecisionDetail({ ...baseDetail, trigger }),
        stage: assessment.maturity.stage,
        role: 'position_exit',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        targetPrice: plannedExitTarget,
      }
    }
    return {
      action: 'TAKE_PROFIT',
      reason,
      detail: s12DecisionDetail({ ...baseDetail, trigger, sell_shares: shares }),
      stage: assessment.maturity.stage,
      role: 'position_exit',
      source: 's12_position_decision_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      targetPrice: plannedExitTarget,
      sellShares: shares,
      sellRatio: 1,
    }
  }

  if (dailyWeak && session60Weak && pnlPct > 0) {
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: 's12_daily_session_60m_bearish_profit_protect_quote_unavailable',
        detail: s12DecisionDetail({ ...baseDetail, trigger: 'daily_session_60m_bearish_profit_protect' }),
        stage: assessment.maturity.stage,
        role: 'position_defense',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
      }
    }
    return {
      action: 'EXIT_ON_REVERSE_BOS',
      reason: 's12_daily_session_60m_bearish_profit_protect_full_exit',
      detail: s12DecisionDetail({ ...baseDetail, trigger: 'daily_session_60m_bearish_profit_protect', sell_shares: shares }),
      stage: assessment.maturity.stage,
      role: 'position_defense',
      source: 's12_position_decision_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      sellShares: shares,
      sellRatio: 1,
    }
  }

  if (assessment.bearishDefense.ready && structuralStop != null && currentPrice <= structuralStop) {
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: 's12_reverse_bos_quote_unavailable',
        detail: s12DecisionDetail({ ...baseDetail, trigger: 'reverse_bos' }),
        stage: assessment.maturity.stage,
        role: 'position_defense',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        stopPrice: structuralStop,
      }
    }
    return {
      action: 'EXIT_ON_REVERSE_BOS',
      reason: 's12_reverse_bos_full_exit',
      detail: s12DecisionDetail({ ...baseDetail, trigger: 'reverse_bos', sell_shares: shares }),
      stage: assessment.maturity.stage,
      role: 'position_defense',
      source: 's12_position_decision_v1',
      executableBookRequired: true,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      stopPrice: structuralStop,
      sellShares: shares,
      sellRatio: 1,
    }
  }

  if (bearishDefenseReady) {
    const currentTrailing =
      finitePositive(input.pos.trailing_stop) ??
      finitePositive(input.pos.initial_stop) ??
      entryPrice * 0.92
    const proposed = s12StructuralStop != null
      ? Math.max(currentTrailing, s12StructuralStop)
      : null
    const newStop = proposed != null ? price(proposed) : null
    if (newStop != null && newStop > currentTrailing) {
      return {
        action: 'TIGHTEN_STOP',
        reason: tp1Hit || pnlPct >= 0.02
          ? 's12_bearish_defense_structure_profit_lock_tighten_stop'
          : 's12_bearish_defense_structure_tighten_stop',
        detail: s12DecisionDetail({ ...baseDetail, trigger: 'bearish_defense', stop: newStop }),
        stage: assessment.maturity.stage,
        role: 'position_defense',
        source: 's12_position_decision_v1',
        executableBookRequired: false,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        stopPrice: newStop,
      }
    }
  }

  if (s12StructuralStop != null && structuralStop != null && currentPrice > structuralStop) {
    const reason = structuralStopFromAssessment
      ? 's12_position_structural_stop_watch_exit_fusion'
      : 's12_position_structural_stop_watch'
    return {
      action: 'SET_STRUCTURAL_STOP',
      reason,
      detail: s12DecisionDetail({ ...baseDetail, trigger: 'position_structural_stop_watch', stop: structuralStop }),
      stage: assessment.maturity.stage,
      role: 'position_defense',
      source: 's12_position_decision_v1',
      executableBookRequired: false,
      noShortOrder: true,
      s12State: assessment.state,
      setupId: assessment.setupId,
      stopPrice: structuralStop,
    }
  }

  return wait()
}
