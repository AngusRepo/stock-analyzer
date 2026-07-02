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
  | 'waiting_4h_completed_bar'
  | 'waiting_4h_long_bias'
  | 'waiting_1h_completed_bar'
  | 'waiting_1h_demand_zone'
  | 'waiting_15m_zone_touch'
  | 'waiting_sweep'
  | 'waiting_choch'
  | 'waiting_bos'
  | 'waiting_retest'
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

export type S12PlannedTakeProfit = 'tp2' | 'tp3' | 'tp4' | 'manual'

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
  rvol: {
    value: number | null
    state: 'strong_participation' | 'participating' | 'thin' | 'unavailable'
    lookbackBars: number
  }
  notes: string[]
}

export interface S12StructureExitPlan {
  mode: 'structure_first_trailing_v1'
  tp1: {
    price: number | null
    source: '15m_previous_high' | 'r_multiple_fallback' | 'unavailable'
    action: 'partial_take_profit'
  }
  mainExit: {
    price: number | null
    zoneLow: number | null
    zoneHigh: number | null
    source: '1h_supply_zone' | 'tp_ladder' | 'r_multiple_fallback' | 'manual' | 'unavailable'
    action: 'main_take_profit'
  }
  tp3: {
    price: number | null
    source: '1h_supply_zone' | 'tp_ladder' | 'r_multiple_fallback' | 'unavailable'
    action: 'extended_take_profit'
  }
  tp4: {
    price: number | null
    source: '1h_supply_zone' | 'tp_ladder' | 'r_multiple_fallback' | 'unavailable'
    action: 'extended_take_profit'
  }
  manualTp: {
    price: number | null
    source: 'manual' | 'unavailable'
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

export type S12H4Source = 'current_session' | 'previous_trading_day_fallback' | 'unavailable'

export type S12RuntimeBarDiagnostics = Record<string, unknown>

export interface S12TimingPolicy {
  min15mBars: number
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
  fullCoverage4hBars: number
}

export const DEFAULT_S12_TIMING_POLICY: S12TimingPolicy = {
  min15mBars: 4,
  atr15mBars: 14,
  zoneAtrBars: 8,
  rvolLookbackBars: 20,
  swingLookbackBars: 6,
  srPivotLen: 8,
  srAtrLen: 14,
  srZoneAtr: 0.2,
  srMergeDistanceAtr: 1.25,
  srBreakBufferAtr: 0.15,
  srBreakConfirmBars: 2,
  obLookbackBars: 20,
  minFvgAtr: 0.05,
  maxVisibleZones: 3,
  positionStopSource: 'adaptive',
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
  fullCoverage4hBars: 2,
}

export interface S12IntradayAssessment {
  version: 's12_intraday_structure_v1'
  symbol: string
  direction: 'long'
  state: S12IntradayState
  ready: boolean
  invalidated: boolean
  reason: string
  detail: string
  setupId: string | null
  completedBars: {
    m15: number
    h1: number
    h4: number
  }
  h4Source: S12H4Source
  h4ReferenceDate: string | null
  h4ReferenceClose: number | null
  barDiagnostics: S12RuntimeBarDiagnostics
  coverage: 'none' | 'partial' | 'full'
  bias4h: S12HtfBias
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
    tp1_hit?: number | null
  }
}

interface S12IntradayInput {
  symbol: string
  bars15m: S12Bar[]
  bars1h: S12Bar[]
  bars4h: S12Bar[]
  bars1d?: S12Bar[]
  fallback1hBars?: S12Bar[]
  nowMs?: number
  min15mBars?: number
  policy?: Partial<S12TimingPolicy> | null
  h4Source?: S12H4Source
  h4ReferenceDate?: string | null
  h4ReferenceClose?: number | null
  barDiagnostics?: S12RuntimeBarDiagnostics | null
}

interface S12FromBaseBarsInput {
  symbol: string
  baseBars: S12Bar[]
  fallback4hBars?: S12Bar[]
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
const H4_MS = 4 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const TW_OFFSET_MS = 8 * H1_MS
const TW_SESSION_OPEN_MS = 9 * H1_MS
const TW_SESSION_CLOSE_MS = (13 * 60 + 30) * 60_000

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
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
  if (key === 'manual') return 'manual'
  return 'tp2'
}

export function normalizeS12TimingPolicy(policy: Partial<S12TimingPolicy> | null | undefined): S12TimingPolicy {
  return {
    min15mBars: boundedInt(policy?.min15mBars, DEFAULT_S12_TIMING_POLICY.min15mBars, 3, 12),
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
    manualTakeProfitPrice: finitePositive(policy?.manualTakeProfitPrice),
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
    fullCoverage4hBars: boundedInt(policy?.fullCoverage4hBars, DEFAULT_S12_TIMING_POLICY.fullCoverage4hBars, 1, 4),
  }
}

export function s12TimingPolicyFromEnv(env: Record<string, unknown> | null | undefined): S12TimingPolicy {
  return normalizeS12TimingPolicy({
    min15mBars: env?.S12_INTRADAY_MIN_15M_BARS as number | undefined,
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
    manualTakeProfitPrice: env?.S12_POSITION_MANUAL_TP_PRICE as number | undefined,
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
    fullCoverage4hBars: env?.S12_INTRADAY_FULL_COVERAGE_4H_BARS as number | undefined,
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
    policy_manual_take_profit_price: price(policy.manualTakeProfitPrice),
    policy_coach_max_wait_bars: policy.coachMaxWaitBars,
    policy_trigger_mode: policy.triggerMode,
    policy_prior_direction_bars: policy.priorDirectionalBars,
    policy_zone_touch_stale_bars: policy.zoneTouchStaleBars,
    policy_sweep_wait_bars: policy.sweepWaitBars,
    policy_choch_wait_bars: policy.chochWaitBars,
    policy_bos_wait_bars: policy.bosWaitBars,
    policy_retest_wait_bars: policy.retestWaitBars,
  }
}

function shouldBlockOn4hBias(h4Source: S12H4Source, bias4h: S12HtfBias): boolean {
  if (bias4h.direction === 'long' && bias4h.channelAlign) return false
  return h4Source === 'current_session'
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

function roundLot(value: number): number {
  return Math.floor(Math.max(0, value) / 1000) * 1000
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

function detailText(parts: Record<string, unknown>): string {
  return Object.entries(parts)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(';')
}

function maturityStage(state: S12IntradayState): S12IntradayAssessment['maturity']['stage'] {
  switch (state) {
    case 'waiting_15m_completed_bars':
    case 'waiting_4h_completed_bar':
    case 'waiting_1h_completed_bar':
      return 'data'
    case 'waiting_4h_long_bias':
      return 'higher_timeframe_bias'
    case 'waiting_1h_demand_zone':
    case 'waiting_15m_zone_touch':
      return 'setup'
    case 'waiting_sweep':
    case 'waiting_choch':
    case 'waiting_bos':
    case 'waiting_retest':
      return 'trigger_sequence'
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

function maturitySnapshot(
  state: S12IntradayState,
  stale?: {
    stale: boolean
    staleReason?: string | null
    staleAfterBars?: number | null
    elapsedBars?: number | null
  },
): S12IntradayAssessment['maturity'] {
  const takeoverRole = maturityTakeoverRole(state)
  return {
    takeoverEligible: takeoverRole !== 'none',
    takeoverRole,
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
    rvol: { value: null, state: 'unavailable', lookbackBars: 0 },
    notes: [],
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

function buildStructureQuality(bars15m: S12Bar[], policy: S12TimingPolicy = DEFAULT_S12_TIMING_POLICY): S12StructureQuality {
  const bars = normalizeBars(bars15m)
  if (!bars.length) return emptyQuality()
  const latest = bars[bars.length - 1]
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
  return {
    pine_v7_parity_contract: 'tp1_tp4_manual_tp_stop_source_role_flip_channel_idm_eqh_eql',
    zone_overlap_detected: zoneOverlap ? 'true' : 'false',
    zone_overlap_priority: zoneOverlap ? 'order_block_over_fvg_when_cross_type_overlap' : null,
    role_flip_detected: roleFlipDemand || roleFlipSupply ? 'true' : 'false',
    role_flip_side: roleFlipDemand && roleFlipSupply ? 'both' : roleFlipDemand ? 'demand' : roleFlipSupply ? 'supply' : null,
    channel_1h_direction: channelDirection(params.bars1h),
    channel_4h_direction: channelDirection(params.bars4h),
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
  const barDiagnostics = input.barDiagnostics ?? {}
  const policy = inputTimingPolicy(input)
  return {
    version: 's12_intraday_structure_v1',
    symbol: input.symbol,
    direction: 'long',
    state,
    ready: false,
    invalidated: state === 'invalidated',
    reason,
    detail: detailText({
      state,
      reason,
      h4_source: h4Source,
      h4_reference_date: input.h4ReferenceDate ?? null,
      h4_reference_close: price(input.h4ReferenceClose),
      h4_fallback_bias_mode: h4Source === 'previous_trading_day_fallback' ? 'context_only' : null,
      ...timingPolicyDetail(policy),
      ...barDiagnostics,
      ...detail,
    }),
    setupId: null,
    completedBars,
    h4Source,
    h4ReferenceDate: input.h4ReferenceDate ?? null,
    h4ReferenceClose: price(input.h4ReferenceClose),
    barDiagnostics,
    coverage: completedBars.h4 > 0 || completedBars.h1 > 0 || completedBars.m15 > 0 ? 'partial' : 'none',
    bias4h: { direction: 'neutral', confidence: 'none', channelAlign: false },
    bias1h: { direction: 'neutral', confidence: 'none', channelAlign: false },
    demandZone1h: null,
    supplyZone1h: null,
    bearishDefense: emptyBearishDefense(),
    defensiveAction: 'none',
    quality: emptyQuality(),
    exitPlan: emptyExitPlan(),
    sequence: {},
    execution: {},
    maturity: maturitySnapshot(state),
  }
}

function resolve4hBias(bars4h: S12Bar[]): S12Bias4h {
  const bars = normalizeBars(bars4h)
  if (bars.length === 0) return { direction: 'neutral', confidence: 'none', channelAlign: false }
  const latest = bars[bars.length - 1]
  const previous = bars[bars.length - 2] ?? null
  const range = Math.max(0.0001, latest.high - latest.low)
  const closePosition = (latest.close - latest.low) / range
  const bullishCandle = latest.close > latest.open && closePosition >= 0.55
  const confirmedStructure = previous != null && latest.close > previous.close && latest.low >= previous.low * 0.995
  const bearishStructure = previous != null && latest.close < previous.close && latest.high <= previous.high * 1.005
  if (bullishCandle && (confirmedStructure || previous == null)) {
    return {
      direction: 'long',
      confidence: confirmedStructure ? 'confirmed' : 'provisional',
      channelAlign: closePosition >= 0.55,
    }
  }
  if (!bullishCandle && bearishStructure) {
    return { direction: 'short', confidence: 'confirmed', channelAlign: false }
  }
  return { direction: 'neutral', confidence: previous == null ? 'provisional' : 'confirmed', channelAlign: closePosition >= 0.5 }
}

function resolve1hBias(bars1h: S12Bar[]): S12HtfBias {
  return resolve4hBias(bars1h)
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

function stateReason(state: S12IntradayState, extra?: string): string {
  if (extra) return extra
  switch (state) {
    case 'waiting_15m_completed_bars': return 's12_waiting_15m_completed_bars'
    case 'waiting_4h_completed_bar': return 's12_waiting_4h_completed_bar'
    case 'waiting_4h_long_bias': return 's12_waiting_4h_long_bias'
    case 'waiting_1h_completed_bar': return 's12_waiting_1h_completed_bar'
    case 'waiting_1h_demand_zone': return 's12_waiting_1h_demand_zone'
    case 'waiting_15m_zone_touch': return 's12_waiting_15m_zone_touch'
    case 'waiting_sweep': return 's12_waiting_sweep'
    case 'waiting_choch': return 's12_waiting_choch'
    case 'waiting_bos': return 's12_waiting_bos'
    case 'waiting_retest': return 's12_waiting_retest'
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
  const ready = params.state === 'reaction_ready'
  const invalidated = params.state === 'invalidated'
  const reason = stateReason(params.state, params.reason)
  const stale = String(params.extraDetail?.stale ?? '').toLowerCase() === 'true'
  const staleReason = params.extraDetail?.stale_reason == null ? null : String(params.extraDetail.stale_reason)
  const staleAfterBars = params.extraDetail?.stale_after_15m_bars == null ? null : Number(params.extraDetail.stale_after_15m_bars)
  const elapsedBars = params.extraDetail?.elapsed_15m_bars == null ? null : Number(params.extraDetail.elapsed_15m_bars)
  const policy = inputTimingPolicy(params.input)
  const coverage =
    params.completedBars.h4 >= policy.fullCoverage4hBars &&
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
  const exitPlan = params.exitPlan ?? emptyExitPlan(bearishDefense)
  const h4Source = params.input.h4Source ?? (params.completedBars.h4 > 0 ? 'current_session' : 'unavailable')
  const barDiagnostics = params.input.barDiagnostics ?? {}
  return {
    version: 's12_intraday_structure_v1',
    symbol: params.input.symbol,
    direction: 'long',
    state: params.state,
    ready,
    invalidated,
    reason,
    detail: detailText({
      state: params.state,
      reason,
      setup_id: params.setupId ?? null,
      coverage,
      bars15m: params.completedBars.m15,
      bars1h: params.completedBars.h1,
      bars4h: params.completedBars.h4,
      h4_source: h4Source,
      h4_reference_date: params.input.h4ReferenceDate ?? null,
      h4_reference_close: price(params.input.h4ReferenceClose),
      h4_fallback_bias_mode: h4Source === 'previous_trading_day_fallback' ? 'context_only' : null,
      ...timingPolicyDetail(policy),
      bias4h: params.bias4h.direction,
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
      manual_tp: exitPlan.manualTp.price,
      manual_tp_source: exitPlan.manualTp.source === 'unavailable' ? null : exitPlan.manualTp.source,
      trailing_method: exitPlan.trailingStop.method,
      trailing_source: exitPlan.trailingStop.source,
      reverse_warning_action: exitPlan.reverseWarning.action === 'none' ? null : exitPlan.reverseWarning.action,
      entry: price(params.execution?.entryPrice),
      chase_ceiling: price(params.execution?.chaseCeiling),
      stop: price(params.execution?.stopLoss),
      t1: price(params.execution?.target1),
      t2: price(params.execution?.target2),
      t3: price(params.execution?.target3),
      t4: price(params.execution?.target4),
      atr15m: price(params.execution?.atr15m),
      r: params.execution?.rMultiple == null ? null : round(params.execution.rMultiple, 4),
      takeover_eligible: ready || invalidated || params.state === 'bearish_defense_ready' ? 'true' : 'false',
      takeover_role: maturityTakeoverRole(params.state),
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
    h4Source,
    h4ReferenceDate: params.input.h4ReferenceDate ?? null,
    h4ReferenceClose: price(params.input.h4ReferenceClose),
    barDiagnostics,
    coverage,
    bias4h: params.bias4h,
    bias1h,
    demandZone1h: params.demandZone1h,
    supplyZone1h,
    bearishDefense,
    defensiveAction,
    quality,
    exitPlan,
    sequence: params.sequence,
    execution: params.execution ?? {},
    maturity: maturitySnapshot(params.state, {
      stale,
      staleReason,
      staleAfterBars: Number.isFinite(staleAfterBars) ? staleAfterBars : null,
      elapsedBars: Number.isFinite(elapsedBars) ? elapsedBars : null,
    }),
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

function nextTargetAbove(candidates: number[], minExclusive: number, fallback: number | null): {
  price: number | null
  source: '15m_previous_high' | 'tp_ladder' | 'r_multiple_fallback' | 'unavailable'
} {
  const structural = candidates.find((candidate) => candidate > minExclusive + 0.01) ?? null
  if (structural != null) return { price: structural, source: 'tp_ladder' }
  if (fallback != null && fallback > minExclusive + 0.01) return { price: fallback, source: 'r_multiple_fallback' }
  return { price: null, source: 'unavailable' }
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
    const stop = ob.low - atr15m * 0.1
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
): number | null {
  const lows = bars
    .slice(Math.max(0, start), Math.min(bars.length, endInclusive + 1))
    .map((bar) => bar.low - atr15m * 0.1)
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
  const protectedLow = protectedLow15mStop(params.bars15m, params.sweepIndex, params.reactionIndex, params.entryPrice, params.atr15m)
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
  const fallbackMainExit = price(params.entryPrice + params.risk * 2)
  const fallbackTp3 = price(params.entryPrice + params.risk * 3)
  const fallbackTp4 = price(params.entryPrice + params.risk * 4)
  const tp1Price = priorHigh ?? fallbackTp1
  const mainExitPrice = supplyExit != null ? price(supplyExit) : fallbackMainExit
  const tp3 = nextTargetAbove(
    [...priorHighs, supplyHigh != null ? price(supplyHigh) : null].filter((value): value is number => value != null),
    mainExitPrice ?? params.entryPrice,
    fallbackTp3,
  )
  const tp4 = nextTargetAbove(priorHighs, tp3.price ?? mainExitPrice ?? params.entryPrice, fallbackTp4)
  const manualTp = params.policy.manualTakeProfitPrice != null && params.policy.manualTakeProfitPrice > params.entryPrice
    ? price(params.policy.manualTakeProfitPrice)
    : null
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
      source: priorHigh != null ? '15m_previous_high' : fallbackTp1 != null ? 'r_multiple_fallback' : 'unavailable',
      action: 'partial_take_profit',
    },
    mainExit: {
      price: mainExitPrice,
      zoneLow: price(supplyLow),
      zoneHigh: price(supplyHigh),
      source: supplyExit != null ? '1h_supply_zone' : fallbackMainExit != null ? 'r_multiple_fallback' : 'unavailable',
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
      price: manualTp,
      source: manualTp != null ? 'manual' : 'unavailable',
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
    return completeAssessment({
      input,
      state: 'waiting_sweep',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs },
      execution: { atr15m },
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
    return completeAssessment({
      input,
      state: 'waiting_choch',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs },
      execution: { atr15m },
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
    return completeAssessment({
      input,
      state: 'waiting_bos',
      completedBars,
      bias4h,
      ...context,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs, chochMs: choch.startMs },
      execution: { atr15m },
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

  let reactionIndex = -1
  const retestEnd = Math.min(bars15m.length - 1, bosIndex + policy.retestWaitBars)
  for (let i = bosIndex + 1; i <= retestEnd; i += 1) {
    const bar = bars15m[i]
    const retest = bar.low <= entryZone.high && bar.high >= entryZone.low
    const reaction = retest && bar.close > bar.open && bar.close >= Math.min(entryZone.high, bar.open + atr15m * 0.08)
    if (reaction) {
      reactionIndex = i
      break
    }
  }
  if (reactionIndex < 0) {
    const elapsedBars = Math.max(0, bars15m.length - 1 - bosIndex)
    const stale = bars15m.length - 1 > retestEnd
    return completeAssessment({
      input,
      state: 'waiting_retest',
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
        stale: stale ? 'true' : null,
        stale_reason: stale ? 'retest_reaction_timeout' : null,
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
  const bars1h = normalizeBars(input.bars1h)
  const bars4h = normalizeBars(input.bars4h)
  const bars1d = normalizeBars(input.bars1d ?? [])
  const fallback1hBars = normalizeBars(input.fallback1hBars ?? [])
  const completedBars = { m15: bars15m.length, h1: bars1h.length, h4: bars4h.length }
  const policy = inputTimingPolicy(input)
  if (bars15m.length < policy.min15mBars) {
    return emptyAssessment(input, 'waiting_15m_completed_bars', 's12_waiting_15m_completed_bars', {
      bars15m: bars15m.length,
      min15mBars: policy.min15mBars,
    }, completedBars)
  }
  if (bars4h.length < 1) {
    return emptyAssessment(input, 'waiting_4h_completed_bar', 's12_waiting_4h_completed_bar', completedBars, completedBars)
  }
  const bias4h = resolve4hBias(bars4h)
  const neutral1hBias: S12HtfBias = { direction: 'neutral', confidence: 'none', channelAlign: false }
  const bias1h = bars1h.length > 0 ? resolve1hBias(bars1h) : neutral1hBias
  const currentSupplyZone1h = bars1h.length > 0 ? findSupplyZone1h(bars1h, policy) : null
  const fallbackSupplyZone1h = !currentSupplyZone1h && fallback1hBars.length > 0 ? findSupplyZone1h(fallback1hBars, policy) : null
  const supplyZone1h = currentSupplyZone1h ?? fallbackSupplyZone1h
  const currentDemandZone1h = bars1h.length > 0 ? findDemandZone1h(bars1h, policy) : null
  const fallbackDemandZone1h = !currentDemandZone1h && fallback1hBars.length > 0 ? findDemandZone1h(fallback1hBars, policy) : null
  const demandZone1h = currentDemandZone1h ?? fallbackDemandZone1h
  const parityDiagnostics = zoneLifecycleDiagnostics({ demandZone1h, supplyZone1h, bars15m, bars1h, bars4h, bars1d, policy })
  const inputWithZoneDiagnostics: S12IntradayInput = {
    ...input,
    barDiagnostics: {
      ...(input.barDiagnostics ?? {}),
      fallback_1h_completed_bars: fallback1hBars.length,
      demand_zone_source: currentDemandZone1h ? 'current_session_1h' : fallbackDemandZone1h ? 'previous_session_1h' : null,
      supply_zone_source: currentSupplyZone1h ? 'current_session_1h' : fallbackSupplyZone1h ? 'previous_session_1h' : null,
      position_planned_tp: policy.plannedTakeProfit,
      manual_tp_price: price(policy.manualTakeProfitPrice),
      ...parityDiagnostics,
    },
  }
  const bearishDefense = scanBearishDefenseSequence({ input: inputWithZoneDiagnostics, bars15m, supplyZone1h, policy })
  const quality = buildStructureQuality(bars15m, policy)

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

  const h4Source = input.h4Source ?? (completedBars.h4 > 0 ? 'current_session' : 'unavailable')
  if (shouldBlockOn4hBias(h4Source, bias4h)) {
    return completeAssessment({
      input: inputWithZoneDiagnostics,
      state: 'waiting_4h_long_bias',
      completedBars,
      bias4h,
      bias1h,
      demandZone1h: null,
      supplyZone1h,
      bearishDefense,
      quality,
      sequence: {},
      extraDetail: {
        latest4h_close: price(bars4h[bars4h.length - 1]?.close),
        required: '4h_long_channel_align',
        h4_bias_gate: 'current_session_only',
      },
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
    })
  }
  return scanLongSequence({ input: inputWithZoneDiagnostics, bars15m, completedBars, bias4h, bias1h, demandZone1h, supplyZone1h, bearishDefense, quality, policy })
}

export function assessS12IntradayStructureFromBaseBars(input: S12FromBaseBarsInput): S12IntradayAssessment {
  const nowMs = input.nowMs ?? Date.now()
  const bars15m = aggregateCompletedS12Bars(input.baseBars, M15_MS, nowMs, { alignToTwSession: true })
  const bars1h = aggregateCompletedS12Bars(input.baseBars, H1_MS, nowMs, { alignToTwSession: true })
  const currentSession4h = aggregateCompletedS12Bars(input.baseBars, H4_MS, nowMs, { alignToTwSession: true })
  const fallback4h = currentSession4h.length > 0
    ? []
    : aggregateCompletedS12Bars(input.fallback4hBars ?? [], H4_MS, nowMs, { alignToTwSession: true })
  const fallback1h = aggregateCompletedS12Bars(input.fallback1hBars ?? [], H1_MS, nowMs, { alignToTwSession: true })
  const bars1d = aggregateTwDailyS12Bars([...(input.fallback4hBars ?? []), ...(input.fallback1hBars ?? []), ...input.baseBars], nowMs)
  const h4Source: S12H4Source = currentSession4h.length > 0
    ? 'current_session'
    : fallback4h.length > 0
      ? 'previous_trading_day_fallback'
      : 'unavailable'
  const bars4h = currentSession4h.length > 0 ? currentSession4h : fallback4h
  return assessS12IntradayStructure({
    symbol: input.symbol,
    nowMs,
    bars15m,
    bars1h,
    bars4h,
    bars1d,
    fallback1hBars: fallback1h,
    h4Source,
    h4ReferenceDate: h4Source === 'previous_trading_day_fallback' ? input.h4ReferenceDate ?? null : null,
    h4ReferenceClose: h4Source === 'previous_trading_day_fallback' ? input.h4ReferenceClose ?? null : null,
    policy: input.policy,
    barDiagnostics: {
      ...(input.barDiagnostics ?? {}),
      ...sessionAggregationDiagnostics(input.baseBars, nowMs),
      completed_15m_bars: bars15m.length,
      completed_1h_bars: bars1h.length,
      completed_4h_current_session_bars: currentSession4h.length,
      completed_4h_fallback_bars: fallback4h.length,
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
  if (mode === 'require_ready' && !assessment.ready) {
    return { action: 'defer', reason: assessment.reason, detail: assessment.detail }
  }
  if ((mode === 'require_ready' || mode === 'assist_entry') && assessment.ready) {
    return { action: 'pass', reason: assessment.reason, detail: assessment.detail }
  }
  return null
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
  if (assessment.ready) {
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
  const tp1 = finitePositive(input.pos.tp1_price) ?? finitePositive(assessment?.exitPlan?.tp1?.price)
  const tp2 = finitePositive(input.pos.tp2_price) ?? finitePositive(assessment?.exitPlan?.mainExit?.price)
  const tp3 = finitePositive(input.pos.tp3_price) ?? finitePositive(assessment?.exitPlan?.tp3?.price)
  const tp4 = finitePositive(input.pos.tp4_price) ?? finitePositive(assessment?.exitPlan?.tp4?.price)
  const manualTp = finitePositive(input.pos.manual_tp_price) ?? finitePositive(assessment?.exitPlan?.manualTp?.price)
  const plannedTp = normalizePlannedTakeProfit(input.pos.planned_take_profit ?? assessment?.barDiagnostics?.position_planned_tp ?? 'tp2')
  const plannedExitTarget =
    plannedTp === 'manual'
      ? manualTp
      : plannedTp === 'tp4'
        ? tp4 ?? tp3 ?? tp2
        : plannedTp === 'tp3'
          ? tp3 ?? tp2
          : tp2
  const structuralStop =
    finitePositive(assessment?.exitPlan?.trailingStop?.initial) ??
    finitePositive(assessment?.execution?.stopLoss) ??
    finitePositive(input.pos.initial_stop) ??
    finitePositive(input.pos.trailing_stop)
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
    manual_tp: price(manualTp),
    planned_take_profit: plannedTp,
    planned_exit_target: price(plannedExitTarget),
    structural_stop: price(structuralStop),
    structural_stop_source: assessment?.exitPlan?.trailingStop?.source ?? null,
    structural_stop_method: assessment?.exitPlan?.trailingStop?.method ?? null,
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
  const sellRatio = boundedRatio(input.tp1SellRatio, 0.5)
  const partialShares = roundLot(originalShares * sellRatio)
  const clampedPartial = partialShares > 0 && partialShares < shares ? partialShares : shares

  if (!tp1Hit && tp1 != null && currentPrice >= tp1) {
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: 's12_tp1_quote_unavailable',
        detail: s12DecisionDetail({ ...baseDetail, trigger: 'tp1' }),
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
      detail: s12DecisionDetail({ ...baseDetail, trigger: 'tp1', sell_shares: clampedPartial, sell_ratio: sellRatio }),
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
    const trigger = plannedTp === 'manual' ? 'manual_tp' : plannedTp
    const reason = plannedTp === 'manual'
      ? 's12_manual_take_profit'
      : plannedTp === 'tp4'
        ? 's12_tp4_extended_take_profit'
        : plannedTp === 'tp3'
          ? 's12_tp3_extended_take_profit'
          : 's12_tp2_main_take_profit'
    if (!input.executableBookAvailable) {
      return {
        action: 'QUOTE_UNAVAILABLE',
        reason: plannedTp === 'manual' ? 's12_manual_tp_quote_unavailable' : `s12_${plannedTp}_quote_unavailable`,
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

  if (assessment.bearishDefense.ready && structuralStop != null && currentPrice <= structuralStop && currentPrice < entryPrice) {
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

  if (assessment.bearishDefense.ready || assessment.state === 'bearish_defense_ready') {
    if (!tp1Hit && pnlPct >= 0.04) {
      if (!input.executableBookAvailable) {
        return {
          action: 'QUOTE_UNAVAILABLE',
          reason: 's12_bearish_defense_quote_unavailable',
          detail: s12DecisionDetail({ ...baseDetail, trigger: 'bearish_defense_take_profit' }),
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
        action: 'TAKE_PROFIT',
        reason: 's12_bearish_defense_partial_take_profit',
        detail: s12DecisionDetail({ ...baseDetail, trigger: 'bearish_defense', sell_shares: clampedPartial, sell_ratio: sellRatio }),
        stage: assessment.maturity.stage,
        role: 'position_defense',
        source: 's12_position_decision_v1',
        executableBookRequired: true,
        noShortOrder: true,
        s12State: assessment.state,
        setupId: assessment.setupId,
        sellShares: clampedPartial,
        sellRatio,
      }
    }
    const currentTrailing =
      finitePositive(input.pos.trailing_stop) ??
      finitePositive(input.pos.initial_stop) ??
      entryPrice * 0.92
    const effectiveAtr = atr ?? currentPrice * 0.02
    const belowCurrentCap = currentPrice - effectiveAtr * 0.2
    const profitFloor = currentPrice > entryPrice ? entryPrice : currentPrice - effectiveAtr * 0.6
    const structuralTrail = currentPrice - effectiveAtr * (tp1Hit ? 0.55 : 0.8)
    const proposed = Math.min(belowCurrentCap, Math.max(currentTrailing, profitFloor, structuralTrail))
    const newStop = price(Math.max(currentTrailing, proposed))
    if (newStop != null && newStop > currentTrailing) {
      return {
        action: 'TIGHTEN_STOP',
        reason: tp1Hit || pnlPct >= 0.02
          ? 's12_bearish_defense_take_profit_or_tighten_stop'
          : 's12_bearish_defense_tighten_stop',
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

  return wait()
}
