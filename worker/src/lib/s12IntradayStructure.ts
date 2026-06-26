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
  | 'invalidated'

export interface S12IntradayZone {
  type: 'order_block' | 'pivot_demand'
  low: number
  high: number
  createdMs: number
  ageBars: number
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
  coverage: 'none' | 'partial' | 'full'
  bias4h: {
    direction: 'long' | 'neutral' | 'short'
    confidence: 'none' | 'provisional' | 'confirmed'
    channelAlign: boolean
  }
  demandZone1h: S12IntradayZone | null
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
    atr15m?: number | null
    rMultiple?: number | null
  }
}

interface S12IntradayInput {
  symbol: string
  bars15m: S12Bar[]
  bars1h: S12Bar[]
  bars4h: S12Bar[]
  nowMs?: number
  min15mBars?: number
}

interface S12FromBaseBarsInput {
  symbol: string
  baseBars: S12Bar[]
  nowMs?: number
}

interface S12Bias4h {
  direction: 'long' | 'neutral' | 'short'
  confidence: 'none' | 'provisional' | 'confirmed'
  channelAlign: boolean
}

const M15_MS = 15 * 60_000
const H1_MS = 60 * 60_000
const H4_MS = 4 * 60 * 60_000

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
): S12Bar[] {
  const tf = Math.max(60_000, Math.floor(timeframeMs))
  const buckets = new Map<number, S12Bar>()
  for (const bar of normalizeBars(bars)) {
    const startMs = Math.floor(bar.startMs / tf) * tf
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

function setupKey(symbol: string, ...parts: Array<number | null | undefined>): string {
  const suffix = parts
    .filter((value): value is number => Number.isFinite(Number(value)))
    .map((value) => Math.floor(Number(value) / 60_000).toString(36))
    .join('-')
  return `s12l-${symbol}-${suffix}`
}

function emptyAssessment(
  input: Pick<S12IntradayInput, 'symbol'>,
  state: S12IntradayState,
  reason: string,
  detail: Record<string, unknown>,
  completedBars: S12IntradayAssessment['completedBars'],
): S12IntradayAssessment {
  return {
    version: 's12_intraday_structure_v1',
    symbol: input.symbol,
    direction: 'long',
    state,
    ready: false,
    invalidated: state === 'invalidated',
    reason,
    detail: detailText({ state, reason, ...detail }),
    setupId: null,
    completedBars,
    coverage: completedBars.h4 > 0 || completedBars.h1 > 0 || completedBars.m15 > 0 ? 'partial' : 'none',
    bias4h: { direction: 'neutral', confidence: 'none', channelAlign: false },
    demandZone1h: null,
    sequence: {},
    execution: {},
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

function findDemandZone1h(bars1h: S12Bar[]): S12IntradayZone | null {
  const bars = normalizeBars(bars1h)
  if (!bars.length) return null
  const atr = averageTrueRange(bars, 8) ?? Math.max(0.01, bars[bars.length - 1].high - bars[bars.length - 1].low)
  for (let i = bars.length - 1; i >= 1; i -= 1) {
    const previous = bars[i - 1]
    const current = bars[i]
    const body = Math.abs(current.close - current.open)
    const bullishDisplacement = current.close > current.open && current.close > previous.high && body >= atr * 0.18
    if (!bullishDisplacement) continue
    const low = Math.min(previous.low, current.low)
    const high = Math.max(low + atr * 0.2, Math.min(previous.high, current.close))
    return {
      type: 'order_block',
      low: round(low, 4),
      high: round(Math.max(high, low + 0.01), 4),
      createdMs: current.startMs + H1_MS,
      ageBars: bars.length - 1 - i,
    }
  }
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i]
    const closePosition = (bar.close - bar.low) / Math.max(0.0001, bar.high - bar.low)
    if (bar.close <= bar.open || closePosition < 0.5) continue
    const high = Math.min(bar.high, bar.low + atr * 0.55)
    return {
      type: 'pivot_demand',
      low: round(bar.low, 4),
      high: round(Math.max(high, bar.low + 0.01), 4),
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
    case 'invalidated': return 's12_structure_invalidated'
  }
}

function completeAssessment(params: {
  input: S12IntradayInput
  state: S12IntradayState
  reason?: string
  completedBars: S12IntradayAssessment['completedBars']
  bias4h: S12Bias4h
  demandZone1h: S12IntradayZone | null
  sequence: S12IntradayAssessment['sequence']
  execution?: S12IntradayAssessment['execution']
  setupId?: string | null
  extraDetail?: Record<string, unknown>
}): S12IntradayAssessment {
  const ready = params.state === 'reaction_ready'
  const invalidated = params.state === 'invalidated'
  const reason = stateReason(params.state, params.reason)
  const coverage = params.completedBars.h4 >= 2 && params.completedBars.h1 >= 3 && params.completedBars.m15 >= 12
    ? 'full'
    : 'partial'
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
      bias4h: params.bias4h.direction,
      bias_confidence: params.bias4h.confidence,
      zone_low: price(params.demandZone1h?.low),
      zone_high: price(params.demandZone1h?.high),
      zone_type: params.demandZone1h?.type,
      entry: price(params.execution?.entryPrice),
      chase_ceiling: price(params.execution?.chaseCeiling),
      stop: price(params.execution?.stopLoss),
      t1: price(params.execution?.target1),
      t2: price(params.execution?.target2),
      t3: price(params.execution?.target3),
      atr15m: price(params.execution?.atr15m),
      r: params.execution?.rMultiple == null ? null : round(params.execution.rMultiple, 4),
      ...params.extraDetail,
    }),
    setupId: params.setupId ?? null,
    completedBars: params.completedBars,
    coverage,
    bias4h: params.bias4h,
    demandZone1h: params.demandZone1h,
    sequence: params.sequence,
    execution: params.execution ?? {},
  }
}

function lastBearishBar(bars: S12Bar[], start: number, endInclusive: number): S12Bar | null {
  for (let i = Math.min(endInclusive, bars.length - 1); i >= Math.max(0, start); i -= 1) {
    if (bars[i].close < bars[i].open) return bars[i]
  }
  return null
}

function scanLongSequence(params: {
  input: S12IntradayInput
  bars15m: S12Bar[]
  completedBars: S12IntradayAssessment['completedBars']
  bias4h: S12Bias4h
  demandZone1h: S12IntradayZone
}): S12IntradayAssessment {
  const { input, bars15m, completedBars, bias4h, demandZone1h } = params
  const atr15m = averageTrueRange(bars15m, 14) ?? Math.max(0.01, bars15m[bars15m.length - 1].high - bars15m[bars15m.length - 1].low)
  const eligibleBars = bars15m.filter((bar) => bar.startMs >= demandZone1h.createdMs)
  const offset = bars15m.length - eligibleBars.length
  const touchRelative = eligibleBars.findIndex((bar) => overlapsZone(bar, demandZone1h))
  if (touchRelative < 0) {
    return completeAssessment({
      input,
      state: 'waiting_15m_zone_touch',
      completedBars,
      bias4h,
      demandZone1h,
      sequence: {},
      execution: { atr15m },
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
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs },
      execution: { atr15m },
      setupId: setupKey(input.symbol, touch.startMs),
      extraDetail: { invalidated_by: '15m_close_below_1h_demand' },
    })
  }

  let sweepIndex = -1
  const sweepEnd = Math.min(bars15m.length - 1, touchIndex + 16)
  for (let i = touchIndex; i <= sweepEnd; i += 1) {
    const priorLow = lowBetween(bars15m, Math.max(0, i - 6), i)
    if (priorLow == null) continue
    const bar = bars15m[i]
    const priorDown = bars15m.slice(Math.max(0, i - 3), i).some((candidate) => candidate.close < candidate.open)
    const reclaimed = bar.close > Math.max(demandZone1h.low, bar.low + atr15m * 0.12)
    if (priorDown && bar.low < priorLow && reclaimed && bar.low <= demandZone1h.high) {
      sweepIndex = i
      break
    }
  }
  if (sweepIndex < 0) {
    return completeAssessment({
      input,
      state: 'waiting_sweep',
      completedBars,
      bias4h,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs },
      execution: { atr15m },
      setupId: setupKey(input.symbol, touch.startMs),
    })
  }
  const sweep = bars15m[sweepIndex]

  let chochIndex = -1
  const chochLevel = highBetween(bars15m, Math.max(0, sweepIndex - 6), sweepIndex + 1)
  const chochEnd = Math.min(bars15m.length - 1, sweepIndex + 12)
  for (let i = sweepIndex + 1; i <= chochEnd; i += 1) {
    const bar = bars15m[i]
    const body = Math.abs(bar.close - bar.open)
    if (chochLevel != null && bar.close > chochLevel && bar.close > bar.open && body >= atr15m * 0.08) {
      chochIndex = i
      break
    }
  }
  if (chochIndex < 0) {
    return completeAssessment({
      input,
      state: 'waiting_choch',
      completedBars,
      bias4h,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs },
      execution: { atr15m },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs),
    })
  }
  const choch = bars15m[chochIndex]

  let bosIndex = -1
  const bosLevel = highBetween(bars15m, touchIndex, chochIndex + 1)
  const bosEnd = Math.min(bars15m.length - 1, chochIndex + 24)
  for (let i = chochIndex + 1; i <= bosEnd; i += 1) {
    const bar = bars15m[i]
    const higherLow = lowBetween(bars15m, chochIndex + 1, i + 1)
    if (bosLevel != null && bar.close > bosLevel && (higherLow == null || higherLow > sweep.low)) {
      bosIndex = i
      break
    }
  }
  if (bosIndex < 0) {
    return completeAssessment({
      input,
      state: 'waiting_bos',
      completedBars,
      bias4h,
      demandZone1h,
      sequence: { zoneTouchMs: touch.startMs, sweepMs: sweep.startMs, chochMs: choch.startMs },
      execution: { atr15m },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs, choch.startMs),
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
  const retestEnd = Math.min(bars15m.length - 1, bosIndex + 16)
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
    return completeAssessment({
      input,
      state: 'waiting_retest',
      completedBars,
      bias4h,
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

  const reaction = bars15m[reactionIndex]
  const entryPrice = reaction.close
  const stopLoss = Math.min(sweep.low, entryZone.low) - atr15m * 0.1
  const risk = entryPrice - stopLoss
  if (risk <= 0 || risk > atr15m * 3) {
    return completeAssessment({
      input,
      state: 'invalidated',
      reason: 's12_invalid_risk_box',
      completedBars,
      bias4h,
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
        stopLoss,
        atr15m,
        rMultiple: risk / atr15m,
      },
      setupId: setupKey(input.symbol, touch.startMs, sweep.startMs, choch.startMs, bos.startMs, reaction.startMs),
    })
  }

  return completeAssessment({
    input,
    state: 'reaction_ready',
    completedBars,
    bias4h,
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
      stopLoss,
      target1: entryPrice + risk,
      target2: entryPrice + risk * 2,
      target3: entryPrice + risk * 3,
      atr15m,
      rMultiple: risk / atr15m,
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
  const completedBars = { m15: bars15m.length, h1: bars1h.length, h4: bars4h.length }
  const min15mBars = Math.max(4, Math.floor(input.min15mBars ?? 6))
  if (bars15m.length < min15mBars) {
    return emptyAssessment(input, 'waiting_15m_completed_bars', 's12_waiting_15m_completed_bars', {
      bars15m: bars15m.length,
      min15mBars,
    }, completedBars)
  }
  if (bars4h.length < 1) {
    return emptyAssessment(input, 'waiting_4h_completed_bar', 's12_waiting_4h_completed_bar', completedBars, completedBars)
  }
  const bias4h = resolve4hBias(bars4h)
  if (bias4h.direction !== 'long' || !bias4h.channelAlign) {
    return completeAssessment({
      input,
      state: 'waiting_4h_long_bias',
      completedBars,
      bias4h,
      demandZone1h: null,
      sequence: {},
      extraDetail: {
        latest4h_close: price(bars4h[bars4h.length - 1]?.close),
      },
    })
  }
  if (bars1h.length < 1) {
    return completeAssessment({
      input,
      state: 'waiting_1h_completed_bar',
      completedBars,
      bias4h,
      demandZone1h: null,
      sequence: {},
    })
  }
  const demandZone1h = findDemandZone1h(bars1h)
  if (!demandZone1h) {
    return completeAssessment({
      input,
      state: 'waiting_1h_demand_zone',
      completedBars,
      bias4h,
      demandZone1h: null,
      sequence: {},
    })
  }
  return scanLongSequence({ input, bars15m, completedBars, bias4h, demandZone1h })
}

export function assessS12IntradayStructureFromBaseBars(input: S12FromBaseBarsInput): S12IntradayAssessment {
  const nowMs = input.nowMs ?? Date.now()
  return assessS12IntradayStructure({
    symbol: input.symbol,
    nowMs,
    bars15m: aggregateCompletedS12Bars(input.baseBars, M15_MS, nowMs),
    bars1h: aggregateCompletedS12Bars(input.baseBars, H1_MS, nowMs),
    bars4h: aggregateCompletedS12Bars(input.baseBars, H4_MS, nowMs),
  })
}

export type S12IntradayGateMode = 'observe' | 'block_invalidated' | 'require_ready' | 'assist_entry'

export function s12PreTradeTechnicalDecision(
  assessment: S12IntradayAssessment,
  mode: S12IntradayGateMode = 'observe',
): { action: 'pass' | 'defer' | 'skip'; reason: string; detail: string } | null {
  if (mode === 'observe') return null
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
