export interface IntradayRollingBar {
  startMs: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface IntradayTechnicalSnapshotInput {
  symbol: string
  previousClose: number
  previousAtr14: number
  previousObvTemperature60?: number | null
  previousAdaptiveRsiUpper50?: number | null
  sessionHigh?: number | null
  sessionLow?: number | null
  sessionTotalVolume?: number | null
  rollingBars: IntradayRollingBar[]
  atrPeriod?: number
}

export interface IntradayTechnicalSnapshot {
  source: 'intraday_rolling_bar'
  symbol: string
  barCount: number
  latestClose: number
  sessionHigh: number
  sessionLow: number
  totalVolume: number
  vwap: number
  priceVsVwapPct: number | null
  rangePosition: number | null
  currentAtr14: number
  atrExpansionRatio: number | null
  atrDefense: number
  obvTemperature60: number
  obvTemperatureDelta: number | null
  adaptiveRsiState: 'constructive' | 'overbought' | 'weak' | 'neutral'
}

export type IntradayTechnicalDecisionAction = 'pass' | 'defer' | 'skip'

export interface IntradayTechnicalDecisionInput {
  snapshot: IntradayTechnicalSnapshot
  strategyMode?: string | null
  marketRiskLevel?: string | null
  minRangePosition?: number | null
  minDistributionSkipBarCount?: number | null
}

export interface IntradayTechnicalDecision {
  action: IntradayTechnicalDecisionAction
  reason: string
  detail: string
}

export function floorRollingBarIntervalMs(requestedMs: number): number {
  const value = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : 30_000
  return Math.max(30_000, Math.round(value / 1000) * 1000)
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function roundToTwTick(price: number): number {
  const abs = Math.abs(price)
  const tick = abs < 10 ? 0.01 : abs < 50 ? 0.05 : abs < 100 ? 0.1 : abs < 500 ? 0.5 : abs < 1000 ? 1 : 5
  return round(Math.round(price / tick) * tick, 2)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function metric(key: string, value: number | string | null | undefined): string | null {
  if (value == null) return null
  if (typeof value === 'number') return `${key}=${round(value, 4)}`
  return `${key}=${value}`
}

export function buildIntradayTechnicalSnapshot(input: IntradayTechnicalSnapshotInput): IntradayTechnicalSnapshot {
  const bars = input.rollingBars
    .filter((bar) =>
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.high >= bar.low,
    )
    .sort((a, b) => a.startMs - b.startMs)
  if (bars.length === 0) {
    throw new Error('rolling_bars_required')
  }

  const latest = bars[bars.length - 1]
  const rollingHigh = Math.max(...bars.map((bar) => bar.high))
  const rollingLow = Math.min(...bars.map((bar) => bar.low))
  const sessionHighInput = finitePositive(input.sessionHigh)
  const sessionLowInput = finitePositive(input.sessionLow)
  const sessionHigh = Math.max(rollingHigh, sessionHighInput ?? rollingHigh)
  const sessionLow = Math.min(rollingLow, sessionLowInput ?? rollingLow)
  const rollingVolume = bars.reduce((acc, bar) => acc + Math.max(0, Number(bar.volume ?? 0)), 0)
  const totalVolume = Math.max(rollingVolume, finiteNumber(input.sessionTotalVolume) ?? rollingVolume)
  const weightedVolume = bars.reduce((acc, bar) => acc + Math.max(0, Number(bar.volume ?? 0)), 0)
  const weightedValue = bars.reduce((acc, bar) => acc + Math.max(0, Number(bar.volume ?? 0)) * bar.close, 0)
  const vwap = weightedVolume > 0
    ? weightedValue / weightedVolume
    : bars.reduce((acc, bar) => acc + bar.close, 0) / bars.length
  const priceVsVwapPct = vwap > 0 ? (latest.close - vwap) / vwap : null
  const rangePosition = sessionHigh > sessionLow ? clamp((latest.close - sessionLow) / (sessionHigh - sessionLow), 0, 1) : null
  const previousClose = input.previousClose
  const trueRange = Math.max(
    sessionHigh - sessionLow,
    Math.abs(sessionHigh - previousClose),
    Math.abs(sessionLow - previousClose),
  )
  const period = Math.max(1, Math.floor(input.atrPeriod ?? 14))
  const previousAtr = Number.isFinite(input.previousAtr14) && input.previousAtr14 > 0 ? input.previousAtr14 : trueRange
  const currentAtr14 = ((previousAtr * (period - 1)) + trueRange) / period
  const atrExpansionRatio = previousAtr > 0 ? currentAtr14 / previousAtr : null
  const priceMovePct = previousClose > 0 ? (latest.close - previousClose) / previousClose : 0
  const volumeWarmth = Math.min(8, totalVolume / 100)
  const previousObv = input.previousObvTemperature60 ?? 50
  const obvTemperature60 = clamp(previousObv + priceMovePct * 100 + (priceMovePct >= 0 ? volumeWarmth : -volumeWarmth), 0, 100)
  const obvTemperatureDelta = input.previousObvTemperature60 == null ? null : obvTemperature60 - input.previousObvTemperature60
  const adaptiveUpper = input.previousAdaptiveRsiUpper50 ?? 70
  const adaptiveRsiState = latest.close >= previousClose * (1 + adaptiveUpper / 1000)
    ? 'overbought'
    : latest.close > previousClose
      ? 'constructive'
      : latest.close < previousClose
        ? 'weak'
        : 'neutral'

  return {
    source: 'intraday_rolling_bar',
    symbol: input.symbol,
    barCount: bars.length,
    latestClose: round(latest.close),
    sessionHigh: round(sessionHigh),
    sessionLow: round(sessionLow),
    totalVolume,
    vwap: round(vwap),
    priceVsVwapPct: priceVsVwapPct == null ? null : round(priceVsVwapPct, 4),
    rangePosition: rangePosition == null ? null : round(rangePosition, 4),
    currentAtr14: round(currentAtr14),
    atrExpansionRatio: atrExpansionRatio == null ? null : round(atrExpansionRatio, 4),
    atrDefense: roundToTwTick(latest.close - currentAtr14),
    obvTemperature60: round(obvTemperature60),
    obvTemperatureDelta: obvTemperatureDelta == null ? null : round(obvTemperatureDelta),
    adaptiveRsiState,
  }
}

export function resolveIntradayTechnicalDecision(input: IntradayTechnicalDecisionInput): IntradayTechnicalDecision {
  const snapshot = input.snapshot
  const mode = String(input.strategyMode ?? '').toLowerCase()
  const marketRisk = String(input.marketRiskLevel ?? 'unknown').toLowerCase()
  const minRangePosition = Number.isFinite(Number(input.minRangePosition))
    ? Number(input.minRangePosition)
    : mode.includes('pullback') || mode.includes('mean')
      ? 0.2
      : 0.3
  const obv = snapshot.obvTemperature60
  const obvDelta = snapshot.obvTemperatureDelta
  const rangePosition = snapshot.rangePosition
  const priceVsVwapPct = snapshot.priceVsVwapPct
  const weakRisk = ['medium', 'high', 'orange', 'red', 'black', 'extreme', 'danger'].includes(marketRisk)
  const belowVwap = priceVsVwapPct != null && priceVsVwapPct < -0.002
  const deeplyBelowVwap = priceVsVwapPct != null && priceVsVwapPct < -0.006
  const lowRange = rangePosition != null && rangePosition < minRangePosition
  const nearSessionLow = rangePosition != null && rangePosition < 0.15
  const coldObv = obv < 45 || (obvDelta != null && obvDelta <= -5)
  const distributionObv = obv < 40 || (obvDelta != null && obvDelta <= -10)
  const minDistributionSkipBarCount = Number.isFinite(Number(input.minDistributionSkipBarCount))
    ? Math.max(1, Number(input.minDistributionSkipBarCount))
    : 60

  const detail = [
    metric('adaptive_rsi', snapshot.adaptiveRsiState),
    metric('obv_temp', obv),
    metric('obv_delta', obvDelta),
    metric('price_vwap_pct', priceVsVwapPct),
    metric('range_position', rangePosition),
    metric('min_range', minRangePosition),
    metric('atr_expansion', snapshot.atrExpansionRatio),
    metric('bar_count', snapshot.barCount),
    metric('market_risk', marketRisk),
  ].filter(Boolean).join(';')

  if (snapshot.adaptiveRsiState === 'weak' && distributionObv && nearSessionLow && (deeplyBelowVwap || weakRisk)) {
    if (snapshot.barCount < minDistributionSkipBarCount) {
      return { action: 'defer', reason: 'technical_distribution_cooldown', detail }
    }
    return { action: 'skip', reason: 'technical_distribution', detail }
  }

  if (snapshot.adaptiveRsiState === 'weak' && coldObv && (lowRange || belowVwap)) {
    return { action: 'defer', reason: 'weak_no_reclaim', detail }
  }

  if (snapshot.adaptiveRsiState === 'overbought' && obv < 55 && rangePosition != null && rangePosition > 0.9) {
    return { action: 'defer', reason: 'overextended_without_obv_confirmation', detail }
  }

  return { action: 'pass', reason: 'intraday_technical_pass', detail }
}
