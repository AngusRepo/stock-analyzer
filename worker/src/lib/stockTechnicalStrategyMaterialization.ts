type NullableNumber = number | null | undefined

export interface StockTechnicalDailyBar {
  date: string
  open: NullableNumber
  high: NullableNumber
  low: NullableNumber
  close: NullableNumber
  volume: NullableNumber
}

export interface StockTechnicalRawSignals {
  close?: NullableNumber
  technicalIndicators?: Record<string, NullableNumber>
  factorSignals?: Record<string, NullableNumber>
}

export interface StockTechnicalMaterializationCandidate {
  raw_signals?: StockTechnicalRawSignals | null
}

interface CleanStockTechnicalDailyBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface StockTechnicalMarketRegime {
  source: 'equal_weight_close_return_proxy'
  latestDate: string | null
  mkt1: boolean
  mkt2: boolean
  marketRet63: number | null
  marketRet126: number | null
  marketRet252: number | null
}

export interface StockTechnicalStrategyMaterializationTelemetry {
  method: 'stock_technical_strategy12_daily_materialization_v2'
  universeCount: number
  materializedCount: number
  scoreCoverage: Record<string, number>
  signalCoverage: Record<string, number>
  admissionCoverage: Record<string, number>
  marketRegime: StockTechnicalMarketRegime | null
  unsupported: {
    stockTechS12Score: 'requires_intraday_15m_1h_4h'
  }
}

type StockTechnicalStrategySuffix = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10' | '11'

interface StockTechnicalAdmissionConfig<T extends StockTechnicalMaterializationCandidate> {
  suffix: StockTechnicalStrategySuffix
  floorScore: number
  targetDailyMatches: number
  broadGate: (candidate: T) => boolean
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function avg(values: Array<NullableNumber>): number | null {
  const clean = values.map(finiteNumber).filter((value): value is number => value != null)
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null
}

function pctChange(current: NullableNumber, previous: NullableNumber): number | null {
  const c = finiteNumber(current)
  const p = finiteNumber(previous)
  if (c == null || p == null || Math.abs(p) <= 1e-12) return null
  return c / p - 1
}

function sliceWindow(values: number[], startInclusive: number, endExclusive: number): number[] {
  if (startInclusive < 0 || endExclusive > values.length || startInclusive >= endExclusive) return []
  return values.slice(startInclusive, endExclusive)
}

function windowAvg(values: number[], length: number, endExclusive = values.length): number | null {
  return avg(sliceWindow(values, endExclusive - length, endExclusive))
}

function windowMax(values: number[], length: number, endExclusive = values.length): number | null {
  const clean = sliceWindow(values, endExclusive - length, endExclusive)
    .map(finiteNumber)
    .filter((value): value is number => value != null)
  return clean.length === length ? Math.max(...clean) : null
}

function windowMin(values: number[], length: number, endExclusive = values.length): number | null {
  const clean = sliceWindow(values, endExclusive - length, endExclusive)
    .map(finiteNumber)
    .filter((value): value is number => value != null)
  return clean.length === length ? Math.min(...clean) : null
}

function wilderRsi(values: number[], period: number): number | null {
  if (period < 1 || values.length <= period) return null
  let avgGain = 0
  let avgLoss = 0
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1]
    avgGain += Math.max(change, 0) / period
    avgLoss += Math.max(-change, 0) / period
  }
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1]
    avgGain = ((period - 1) * avgGain + Math.max(change, 0)) / period
    avgLoss = ((period - 1) * avgLoss + Math.max(-change, 0)) / period
  }
  if (avgLoss <= 1e-12) return avgGain <= 1e-12 ? 50 : 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

function safeRatio(numerator: NullableNumber, denominator: NullableNumber): number | null {  const n = finiteNumber(numerator)
  const d = finiteNumber(denominator)
  if (n == null || d == null || Math.abs(d) <= 1e-12) return null
  return n / d
}

function atrAtIndex(
  bars: CleanStockTechnicalDailyBar[],
  period: number,
  endIndex = bars.length - 1,
): number | null {
  if (endIndex < period || endIndex >= bars.length) return null
  let wilderAverage: number | null = null
  let observations = 0
  for (let index = 1; index <= endIndex; index += 1) {
    const row = bars[index]
    const prevClose = bars[index - 1].close
    const trueRange = Math.max(
      row.high - row.low,
      Math.abs(row.high - prevClose),
      Math.abs(row.low - prevClose),
    )
    wilderAverage = wilderAverage == null
      ? trueRange
      : ((period - 1) * wilderAverage + trueRange) / period
    observations += 1
  }
  return observations >= period ? wilderAverage : null
}

function atrAt(bars: CleanStockTechnicalDailyBar[], period: number): number | null {
  return atrAtIndex(bars, period)
}

function rsiWilderAt(closes: number[], period: number, endIndex = closes.length - 1): number | null {
  if (endIndex < period || endIndex >= closes.length) return null
  let averageGain: number | null = null
  let averageLoss: number | null = null
  let observations = 0
  for (let index = 1; index <= endIndex; index += 1) {
    const delta = closes[index] - closes[index - 1]
    const gain = Math.max(delta, 0)
    const loss = Math.max(-delta, 0)
    averageGain = averageGain == null ? gain : ((period - 1) * averageGain + gain) / period
    averageLoss = averageLoss == null ? loss : ((period - 1) * averageLoss + loss) / period
    observations += 1
  }
  if (observations < period || averageGain == null || averageLoss == null) return null
  if (averageLoss <= 1e-12 && averageGain <= 1e-12) return 50
  if (averageLoss <= 1e-12) return 100
  const relativeStrengthValue = averageGain / averageLoss
  return 100 - 100 / (1 + relativeStrengthValue)
}

function meanAt(values: number[], period: number, index: number): number | null {
  return windowAvg(values, period, index + 1)
}

function volumeRatioAt(volumes: number[], index: number, period = 20): number | null {
  return safeRatio(volumes[index], windowAvg(volumes, period, index))
}

function deriveS05EventFeatures(bars: CleanStockTechnicalDailyBar[]): Record<string, number | null> {
  const i = bars.length - 1
  if (i < 203) return {}
  const closes = bars.map((row) => row.close)
  const highs = bars.map((row) => row.high)
  const volumes = bars.map((row) => row.volume)
  let breakoutIndex: number | null = null
  for (let b = Math.max(0, i - 15); b < i - 2; b += 1) {
    const hhPrev60 = windowMax(highs, 60, b)
    const ma20 = meanAt(closes, 20, b)
    const ma50 = meanAt(closes, 50, b)
    const ma200 = meanAt(closes, 200, b)
    const vr20 = volumeRatioAt(volumes, b)
    if (
      hhPrev60 != null && ma20 != null && ma50 != null && ma200 != null && vr20 != null &&
      closes[b] > hhPrev60 && vr20 >= 1.20 && closes[b] > ma20 && ma20 > ma50 && ma50 > ma200
    ) breakoutIndex = b
  }
  if (breakoutIndex == null) return {
    stockTechS05DaysSinceBreakout: null,
    stockTechS05PullbackDd: null,
    stockTechS05PullbackQuality: null,
    stockTechS05DryupQuality: null,
    stockTechS05PullbackVolRatio: null,
    stockTechS05PathOk: 0,
    stockTechS05Trigger: 0,
  }

  const peakSince = Math.max(...highs.slice(breakoutIndex, i))
  let pathOk = true
  for (let index = breakoutIndex + 1; index <= i; index += 1) {
    const ma50 = meanAt(closes, 50, index)
    if (ma50 == null || closes[index] <= ma50) {
      pathOk = false
      break
    }
  }
  const pullbackRatio = safeRatio(closes[i], peakSince)
  const pullbackDd = pullbackRatio == null ? null : pullbackRatio - 1
  const ma20 = meanAt(closes, 20, i)
  const atr14 = atrAtIndex(bars, 14, i)
  const pullbackVol3 = windowAvg(volumes, 3, i)
  const baselineVol20 = windowAvg(volumes, 20, i - 3)
  const pullbackVolRatio = safeRatio(pullbackVol3, baselineVol20)
  const triggerAt = (index: number) => {
    if (index <= 0 || index >= bars.length) return false
    const row = bars[index]
    const dayRange = Math.max(1e-8, row.high - row.low)
    const clv = clamp((row.close - row.low) / dayRange)
    return row.close > row.open &&
      row.close > bars[index - 1].high &&
      clv >= 0.75 &&
      (volumeRatioAt(volumes, index) ?? 0) >= 1
  }
  let breakoutConsumed = false
  for (let index = breakoutIndex + 3; index < i; index += 1) {
    if (triggerAt(index)) {
      breakoutConsumed = true
      break
    }
  }
  const trigger = triggerAt(i) && !breakoutConsumed

  return {
    stockTechS05DaysSinceBreakout: i - breakoutIndex,
    stockTechS05PullbackDd: pullbackDd,
    stockTechS05PullbackQuality: pullbackDd == null ? null : clamp(1 - Math.abs(pullbackDd + 0.06) / 0.06),
    stockTechS05DryupQuality: pullbackVolRatio == null ? null : clamp(1 - pullbackVolRatio),
    stockTechS05PullbackVolRatio: pullbackVolRatio,
    stockTechS05DistMa20Atr: ma20 == null || atr14 == null ? null : safeRatio(Math.abs(closes[i] - ma20), atr14),
    stockTechS05PathOk: pathOk ? 1 : 0,
    stockTechS05Trigger: trigger ? 1 : 0,
  }
}

function deriveS10EventFeatures(bars: CleanStockTechnicalDailyBar[]): Record<string, number | null> {
  const i = bars.length - 1
  if (i < 55) return {}
  const closes = bars.map((row) => row.close)
  const highs = bars.map((row) => row.high)
  const lows = bars.map((row) => row.low)
  const volumes = bars.map((row) => row.volume)
  let downGapIndex: number | null = null
  let preDecline: number | null = null
  for (let a = Math.max(22, i - 5); a < i; a += 1) {
    const atrPrev = atrAtIndex(bars, 14, a - 1)
    const ma20Prev = meanAt(closes, 20, a - 1)
    const ma50Prev = meanAt(closes, 50, a - 1)
    const decline = pctChange(closes[a - 1], closes[a - 21])
    const gapDownAtr = atrPrev == null ? null : safeRatio(lows[a - 1] - highs[a], atrPrev)
    if (
      highs[a] < lows[a - 1] &&
      gapDownAtr != null && gapDownAtr >= 0.10 &&
      ma20Prev != null && ma50Prev != null && closes[a - 1] < ma20Prev && ma20Prev < ma50Prev &&
      decline != null && decline <= -0.08
    ) {
      downGapIndex = a
      preDecline = -decline
    }
  }
  if (downGapIndex == null) return {
    stockTechS10GapUpAtr: null,
    stockTechS10PreDecline: null,
    stockTechS10IslandLow: null,
    stockTechS10Trigger: 0,
  }

  const islandHigh = Math.max(...highs.slice(downGapIndex, i))
  const islandLow = Math.min(...lows.slice(downGapIndex, i))
  const atr14 = atrAtIndex(bars, 14, i)
  const gapUpAtr = atr14 == null ? null : safeRatio(lows[i] - islandHigh, atr14)
  const dayRange = Math.max(1e-8, bars[i].high - bars[i].low)
  const clv = clamp((bars[i].close - bars[i].low) / dayRange)
  const trigger = islandHigh < lows[downGapIndex - 1] &&
    lows[i] > islandHigh &&
    gapUpAtr != null && gapUpAtr >= 0.10 &&
    bars[i].close > bars[i].open &&
    clv >= 0.70 &&
    (volumeRatioAt(volumes, i) ?? 0) >= 1.50

  return {
    stockTechS10GapUpAtr: trigger ? gapUpAtr : null,
    stockTechS10PreDecline: trigger ? preDecline : null,
    stockTechS10IslandLow: trigger ? islandLow : null,
    stockTechS10Trigger: trigger ? 1 : 0,
  }
}
function rankPercentile(value: NullableNumber, sortedAsc: number[]): number | null {
  const num = finiteNumber(value)
  if (num == null || sortedAsc.length < 2) return null
  let lower = 0
  while (lower < sortedAsc.length && sortedAsc[lower] < num) lower += 1
  let upper = lower
  while (upper < sortedAsc.length && sortedAsc[upper] <= num) upper += 1
  const midpoint = (lower + Math.max(lower, upper - 1)) / 2
  return clamp(midpoint / (sortedAsc.length - 1))
}

function relativeStrength(ret: NullableNumber, marketRet: NullableNumber): number | null {
  const stock = finiteNumber(ret)
  const market = finiteNumber(marketRet)
  if (stock == null) return null
  if (market == null || stock <= -0.999 || market <= -0.999) return stock
  return Math.log1p(stock) - Math.log1p(market)
}

function cleanBars(bars: StockTechnicalDailyBar[]): CleanStockTechnicalDailyBar[] {
  return [...bars]
    .map((row) => ({
      date: String(row.date || ''),
      open: finiteNumber(row.open),
      high: finiteNumber(row.high),
      low: finiteNumber(row.low),
      close: finiteNumber(row.close),
      volume: finiteNumber(row.volume) ?? 0,
    }))
    .filter((row): row is CleanStockTechnicalDailyBar =>
      !!row.date &&
      row.open != null &&
      row.high != null &&
      row.low != null &&
      row.close != null &&
      row.high >= row.low,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
}

export function deriveStockTechnicalDailyFeatures(
  barsInput: StockTechnicalDailyBar[],
): Record<string, number | null> {
  const bars = cleanBars(barsInput)
  const n = bars.length
  if (!n) return {}

  const latest = bars[n - 1]
  const prev = bars[n - 2]
  const closes = bars.map((row) => row.close)
  const highs = bars.map((row) => row.high)
  const lows = bars.map((row) => row.low)
  const volumes = bars.map((row) => row.volume)
  const turnovers = bars.map((row) => row.close * row.volume)
  const ranges = bars.map((row) => row.high - row.low)
  const latestRange = Math.max(1e-8, latest.high - latest.low)
  const atr14 = atrAt(bars, 14)
  const atr20 = atrAt(bars, 20)
  const ma = (period: number, endOffset = 0) => windowAvg(closes, period, n - endOffset)
  const closeShift = (days: number) => (n - 1 - days >= 0 ? closes[n - 1 - days] : null)
  const highShift = (days: number) => (n - 1 - days >= 0 ? highs[n - 1 - days] : null)
  const lowShift = (days: number) => (n - 1 - days >= 0 ? lows[n - 1 - days] : null)
  const openShift = (days: number) => (n - 1 - days >= 0 ? bars[n - 1 - days].open : null)
  const volumeShift = (days: number) => (n - 1 - days >= 0 ? volumes[n - 1 - days] : null)
  const hhPrev = (period: number) => windowMax(highs, period, n - 1)
  const llPrev = (period: number) => windowMin(lows, period, n - 1)
  const rangePrev = (period: number) => {
    const high = hhPrev(period)
    const low = llPrev(period)
    return high != null && low != null && low > 0 ? high / low - 1 : null
  }

  const maxHigh252 = windowMax(highs, 252, n)
  const highPos252 = safeRatio(latest.close, maxHigh252)
  const prevClose = closeShift(1)
  const prevHigh = highShift(1)
  const prevLow = lowShift(1)
  const prev2High = highShift(2)
  const prev2Low = lowShift(2)
  const prevRange = prevHigh != null && prevLow != null ? prevHigh - prevLow : null
  const nr7Window = sliceWindow(ranges, n - 8, n - 1)
  const prevNr7 = prevRange != null && nr7Window.length === 7
    ? prevRange <= Math.min(...nr7Window)
    : false
  const insidePrev = prevHigh != null && prevLow != null && prev2High != null && prev2Low != null
    ? prevHigh < prev2High && prevLow > prev2Low
    : false

  const vmaPrev20 = windowAvg(volumes, 20, n - 1)
  const vmaPrev10 = windowAvg(volumes, 10, n - 1)
  const vmaPrev50 = windowAvg(volumes, 50, n - 1)
  const setupVma20 = avg(sliceWindow(volumes, n - 22, n - 2))
  const gapPct = pctChange(latest.open, prevClose)
  const gapQuality = gapPct == null ? null : clamp(1 - Math.abs(gapPct - 0.03) / 0.02)
  const natr20 = safeRatio(atr20, latest.close)
  const rangeAtr = safeRatio(latest.high - latest.low, atr14)
  const clv = (latest.close - latest.low) / latestRange
  const bodyFrac = Math.abs(latest.close - latest.open) / latestRange
  const upperWickFrac = (latest.high - Math.max(latest.open, latest.close)) / latestRange
  const hhPrev20 = hhPrev(20)
  const close20 = closeShift(20)
  const close21 = closeShift(21)
  const close252 = closeShift(252) ?? closeShift(251)
  const stretch = hhPrev20 == null ? null : safeRatio(latest.close - hhPrev20, atr14)
  const rangePrev10 = rangePrev(10)
  const rangePrev20 = rangePrev(20)
  const rangePrev60 = rangePrev(60)
  const contract10_20Ratio = safeRatio(rangePrev10, rangePrev20)
  const contract20_60Ratio = safeRatio(rangePrev20, rangePrev60)
  const dryup10_50Ratio = safeRatio(vmaPrev10, vmaPrev50)
  const atr14Prev = atrAtIndex(bars, 14, n - 2)
  const rsi2 = rsiWilderAt(closes, 2, n - 1)
  const rsi2Prev = rsiWilderAt(closes, 2, n - 2)
  const vr20Prev = volumeRatioAt(volumes, n - 2)
  const support20Shift2 = windowMin(lows, 20, n - 2)
  const breakDepth = support20Shift2 == null || prevLow == null || atr14Prev == null
    ? null
    : safeRatio(support20Shift2 - prevLow, atr14Prev)
  const closeBreakDepth = support20Shift2 == null || prevClose == null || atr14Prev == null
    ? null
    : safeRatio(support20Shift2 - prevClose, atr14Prev)
  const reclaimStrength = support20Shift2 == null || atr14 == null
    ? null
    : safeRatio(latest.close - support20Shift2, atr14)
  const ma200Shift2 = meanAt(closes, 200, n - 3)
  const ma200Shift22 = meanAt(closes, 200, n - 23)
  const currentMa5 = ma(5)
  const ma5Distance = atr14 == null || currentMa5 == null ? null : safeRatio(currentMa5 - latest.close, atr14)
  const baseTop = windowMax(highs, 20, n - 3)
  const baseBottom = windowMin(lows, 20, n - 3)
  const baseRatio = safeRatio(baseTop, baseBottom)
  const baseWidth = baseRatio == null ? null : baseRatio - 1
  const candleOk = (index: number) => {
    if (index < 0 || index >= bars.length) return false
    const row = bars[index]
    const range = Math.max(1e-8, row.high - row.low)
    const rowClv = (row.close - row.low) / range
    const rowBody = Math.abs(row.close - row.open) / range
    const rowUpperWick = (row.high - Math.max(row.open, row.close)) / range
    return row.close > row.open && rowBody >= 0.55 && rowUpperWick <= 0.25 && rowClv >= 0.70
  }
  const opensInside = n >= 3 &&
    bars[n - 2].open >= bars[n - 3].open && bars[n - 2].open <= bars[n - 3].close &&
    latest.open >= bars[n - 2].open && latest.open <= bars[n - 2].close
  const ret3 = pctChange(latest.close, closeShift(3))
  const vol3Ratio = safeRatio(windowAvg(volumes, 3, n), windowAvg(volumes, 20, n - 3))
  const heatQuality = ret3 == null ? null : clamp(1 - (ret3 - 0.03) / 0.09)
  const s05EventFeatures = deriveS05EventFeatures(bars)
  const s10EventFeatures = deriveS10EventFeatures(bars)
  return {
    stockTechHistoryDays: n,
    stockTechLatestOpen: latest.open,
    stockTechLatestHigh: latest.high,
    stockTechLatestLow: latest.low,
    stockTechLatestClose: latest.close,
    stockTechTurnover20: windowAvg(turnovers, 20),
    stockTechMa5: ma(5),
    stockTechMa10: ma(10),
    stockTechMa20: ma(20),
    stockTechMa50: ma(50),
    stockTechMa60: ma(60),
    stockTechMa100: ma(100),
    stockTechMa120: ma(120),
    stockTechMa150: ma(150),
    stockTechMa200: ma(200),
    stockTechPrevClose: prevClose,
    stockTechPrev2Close: closeShift(2),
    stockTechPrevOpen: openShift(1),
    stockTechPrevHigh: prevHigh,
    stockTechPrevLow: prevLow,
    stockTechPrevMa20: ma(20, 1),
    stockTechPrevMa50: ma(50, 1),
    stockTechPrevMa200: ma(200, 1),
    stockTechMa50Ago20: ma(50, 20),
    stockTechMa200Ago20: ma(200, 20),
    stockTechHhPrev20: hhPrev20,
    stockTechHhPrev55: hhPrev(55),
    stockTechHhPrev60: hhPrev(60),
    stockTechLlPrev10: llPrev(10),
    stockTechLlPrev20: llPrev(20),
    stockTechRangePrev10: rangePrev10,
    stockTechRangePrev20: rangePrev20,
    stockTechRangePrev60: rangePrev60,
    stockTechContract10_20: contract10_20Ratio == null ? null : 1 - contract10_20Ratio,
    stockTechContract20_60: contract20_60Ratio == null ? null : 1 - contract20_60Ratio,
    stockTechDryup10_50: dryup10_50Ratio == null ? null : 1 - dryup10_50Ratio,
    stockTechHighPos252: highPos252,
    stockTechReturn63: pctChange(latest.close, closeShift(63)),
    stockTechReturn60: pctChange(latest.close, closeShift(60)),
    stockTechReturn126: pctChange(latest.close, closeShift(126)),
    stockTechReturn252: pctChange(latest.close, close252),
    stockTechReturn63Prev1: pctChange(prevClose, closeShift(64)),
    stockTechMom12_1: pctChange(closeShift(21), close252),
    stockTechAtr14: atr14,
    stockTechAtr14Prev: atr14Prev,
    stockTechRsi2: rsi2,
    stockTechRsi2Prev: rsi2Prev,
    stockTechAtr20: atr20,
    stockTechNatr20: natr20,
    stockTechVr20: safeRatio(latest.volume, vmaPrev20),
    stockTechVr20Prev: vr20Prev,
    stockTechVmaPrev10: vmaPrev10,
    stockTechVmaPrev20: vmaPrev20,
    stockTechVmaPrev50: vmaPrev50,
    stockTechSetupVr20: safeRatio(volumeShift(1), setupVma20),
    stockTechInsidePrev: insidePrev ? 1 : 0,
    stockTechNr7Prev: prevNr7 ? 1 : 0,
    stockTechClv: clamp(clv),
    stockTechBodyFrac: clamp(bodyFrac),
    stockTechUpperWickFrac: clamp(upperWickFrac),
    stockTechGapPct: gapPct,
    stockTechGapQuality: gapQuality,
    stockTechRangeAtr: rangeAtr,
    stockTechDeduct20Raw: close20 != null ? latest.close - close20 : null,
    stockTechDeduct20Prev: prevClose != null && close21 != null ? prevClose - close21 : null,
    stockTechStretchHh20Atr: stretch,
    stockTechS07Support20Shift2: support20Shift2,
    stockTechS07BreakDepth: breakDepth,
    stockTechS07CloseBreakDepth: closeBreakDepth,
    stockTechS07ReclaimStrength: reclaimStrength,
    stockTechS07Ma200Shift2: ma200Shift2,
    stockTechS07Ma200Shift22: ma200Shift22,
    stockTechS08Ma5DistanceAtr: ma5Distance,
    stockTechS09BaseTop: baseTop,
    stockTechS09BaseWidth: baseWidth,
    stockTechS09ThreeCandles: candleOk(n - 1) && candleOk(n - 2) && candleOk(n - 3) ? 1 : 0,
    stockTechS09OpensInside: opensInside ? 1 : 0,
    stockTechS09Ret3: ret3,
    stockTechS09Vol3Ratio: vol3Ratio,
    stockTechS09HeatQuality: heatQuality,
    stockTechMa50Ago10: ma(50, 10),
    ...s05EventFeatures,
    ...s10EventFeatures,
  }
}

export function deriveStockTechnicalMarketRegime(
  seriesInput: StockTechnicalDailyBar[][],
): StockTechnicalMarketRegime {
  const returnsByDate = new Map<string, number[]>()
  for (const input of seriesInput) {
    const bars = cleanBars(input)
    for (let index = 1; index < bars.length; index += 1) {
      const ret = pctChange(bars[index].close, bars[index - 1].close)
      if (ret == null) continue
      const bucket = returnsByDate.get(bars[index].date) ?? []
      bucket.push(ret)
      returnsByDate.set(bars[index].date, bucket)
    }
  }

  const dates = [...returnsByDate.keys()].sort()
  const indexRows: Array<{ date: string; value: number }> = []
  let value = 100
  for (const date of dates) {
    const dayReturn = avg(returnsByDate.get(date) ?? []) ?? 0
    value *= 1 + dayReturn
    indexRows.push({ date, value })
  }

  const values = indexRows.map((row) => row.value)
  const latest = indexRows[indexRows.length - 1]
  const ma50 = windowAvg(values, 50)
  const ma200 = windowAvg(values, 200)
  const ret = (days: number) => values.length > days
    ? pctChange(values[values.length - 1], values[values.length - 1 - days])
    : null

  return {
    source: 'equal_weight_close_return_proxy',
    latestDate: latest?.date ?? null,
    mkt1: latest != null && ma200 != null ? latest.value > ma200 : true,
    mkt2: latest != null && ma50 != null && ma200 != null ? latest.value > ma200 && ma50 > ma200 : true,
    marketRet63: ret(63),
    marketRet126: ret(126),
    marketRet252: ret(252),
  }
}

function indicator(candidate: StockTechnicalMaterializationCandidate, key: string): number | null {
  return finiteNumber(candidate.raw_signals?.technicalIndicators?.[key])
}

function ensureTechnicalIndicators(raw: StockTechnicalRawSignals): Record<string, NullableNumber> {
  raw.technicalIndicators = { ...(raw.technicalIndicators ?? {}) }
  return raw.technicalIndicators
}

function setSignalScore(
  raw: StockTechnicalRawSignals,
  suffix: string,
  signal: boolean,
  score: NullableNumber,
  telemetry: StockTechnicalStrategyMaterializationTelemetry,
): void {
  const indicators = ensureTechnicalIndicators(raw)
  const signalKey = `stockTechS${suffix}Signal`
  const scoreKey = `stockTechS${suffix}Score`
  indicators[signalKey] = signal ? 1 : 0
  const cleanScore = finiteNumber(score)
  indicators[scoreKey] = cleanScore == null ? null : round4(clamp(cleanScore))
  if (cleanScore != null) telemetry.scoreCoverage[scoreKey] = (telemetry.scoreCoverage[scoreKey] ?? 0) + 1
  if (signal) telemetry.signalCoverage[signalKey] = (telemetry.signalCoverage[signalKey] ?? 0) + 1
}

function setAdmission(
  raw: StockTechnicalRawSignals,
  suffix: StockTechnicalStrategySuffix,
  admission: boolean,
  telemetry: StockTechnicalStrategyMaterializationTelemetry,
): void {
  const indicators = ensureTechnicalIndicators(raw)
  const admissionKey = `stockTechS${suffix}Admission`
  indicators[admissionKey] = admission ? 1 : 0
  if (admission) telemetry.admissionCoverage[admissionKey] = (telemetry.admissionCoverage[admissionKey] ?? 0) + 1
}

function assignAdaptiveAdmissions<T extends StockTechnicalMaterializationCandidate>(
  candidates: T[],
  telemetry: StockTechnicalStrategyMaterializationTelemetry,
  configs: Array<StockTechnicalAdmissionConfig<T>>,
): void {
  for (const config of configs) {
    const scoreKey = `stockTechS${config.suffix}Score`
    const signalKey = `stockTechS${config.suffix}Signal`
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: indicator(candidate, scoreKey),
      }))
      .filter((row): row is { candidate: T; score: number } =>
        row.score != null &&
        row.score >= config.floorScore &&
        config.broadGate(row.candidate),
      )
      .sort((a, b) => b.score - a.score)
    const cutoffIndex = Math.min(config.targetDailyMatches, ranked.length) - 1
    const adaptiveCutoff = cutoffIndex >= 0 ? ranked[cutoffIndex].score : Infinity

    for (const candidate of candidates) {
      const raw = candidate.raw_signals
      if (!raw) continue
      const scoreValue = indicator(candidate, scoreKey)
      const hardSignal = indicator(candidate, signalKey) === 1
      const scoreAdmission = scoreValue != null &&
        scoreValue >= config.floorScore &&
        scoreValue >= adaptiveCutoff &&
        config.broadGate(candidate)
      setAdmission(raw, config.suffix, hardSignal || scoreAdmission, telemetry)
    }
  }
}

export function materializeStockTechnicalStrategyScores<T extends StockTechnicalMaterializationCandidate>(
  candidates: T[],
  options: { marketRegime?: StockTechnicalMarketRegime | null } = {},
): StockTechnicalStrategyMaterializationTelemetry {
  const telemetry: StockTechnicalStrategyMaterializationTelemetry = {
    method: 'stock_technical_strategy12_daily_materialization_v2',
    universeCount: candidates.length,
    materializedCount: 0,
    scoreCoverage: {},
    signalCoverage: {},
    admissionCoverage: {},
    marketRegime: options.marketRegime ?? null,
    unsupported: {
      stockTechS12Score: 'requires_intraday_15m_1h_4h',
    },
  }
  const market = options.marketRegime ?? null

  const turnoverValues = candidates
    .map((candidate) => indicator(candidate, 'stockTechTurnover20'))
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)

  for (const candidate of candidates) {
    const raw = candidate.raw_signals
    if (!raw) continue
    const indicators = ensureTechnicalIndicators(raw)
    const rs63 = relativeStrength(indicator(candidate, 'stockTechReturn63'), market?.marketRet63 ?? null)
    const rs63Prev = relativeStrength(indicator(candidate, 'stockTechReturn63Prev1'), market?.marketRet63 ?? null)
    const rs126 = relativeStrength(indicator(candidate, 'stockTechReturn126'), market?.marketRet126 ?? null)
    indicators.stockTechRs63 = rs63 == null ? null : round4(rs63)
    indicators.stockTechRs63Prev1 = rs63Prev == null ? null : round4(rs63Prev)
    indicators.stockTechRs126 = rs126 == null ? null : round4(rs126)
    indicators.stockTechNegNatr20 = indicator(candidate, 'stockTechNatr20') == null ? null : -indicator(candidate, 'stockTechNatr20')!
    indicators.stockTechNegRsi2 = indicator(candidate, 'stockTechRsi2') == null ? null : -indicator(candidate, 'stockTechRsi2')!
    indicators.stockTechNegRsi2Prev = indicator(candidate, 'stockTechRsi2Prev') == null ? null : -indicator(candidate, 'stockTechRsi2Prev')!
    indicators.stockTechNegVr20 = indicator(candidate, 'stockTechVr20') == null ? null : -indicator(candidate, 'stockTechVr20')!
    indicators.stockTechNegS09BaseWidth = indicator(candidate, 'stockTechS09BaseWidth') == null ? null : -indicator(candidate, 'stockTechS09BaseWidth')!
    indicators.stockTechLiquidityRank = rankPercentile(indicator(candidate, 'stockTechTurnover20'), turnoverValues)
    indicators.stockTechEligible = (
      (indicator(candidate, 'stockTechHistoryDays') ?? 0) >= 252 &&
      (indicator(candidate, 'stockTechTurnover20') ?? 0) > 0 &&
      (indicators.stockTechLiquidityRank ?? 0) >= 0.30
    ) ? 1 : 0
    indicators.stockTechMarketMkt1 = market?.mkt1 === false ? 0 : 1
    indicators.stockTechMarketMkt2 = market?.mkt2 === false ? 0 : 1
  }

  const sorted = (key: string) => candidates
    .map((candidate) => indicator(candidate, key))
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  const ranksByKey = new Map<string, number[]>()
  const rank = (candidate: T, key: string): number | null => {
    let values = ranksByKey.get(key)
    if (!values) {
      values = sorted(key)
      ranksByKey.set(key, values)
    }
    return rankPercentile(indicator(candidate, key), values)
  }
  const score = (parts: Array<[number, NullableNumber]>): number | null => {
    let weighted = 0
    let weightSum = 0
    for (const [weight, value] of parts) {
      const clean = finiteNumber(value)
      if (clean == null) continue
      weighted += weight * clean
      weightSum += weight
    }
    return weightSum > 0 ? weighted / weightSum : null
  }

  for (const candidate of candidates) {
    const raw = candidate.raw_signals
    if (!raw) continue
    const close = finiteNumber(raw.close)
    const eligible = indicator(candidate, 'stockTechEligible') === 1
    const mkt1 = indicator(candidate, 'stockTechMarketMkt1') === 1
    const mkt2 = indicator(candidate, 'stockTechMarketMkt2') === 1
    const s1Score = score([
      [0.35, rank(candidate, 'stockTechRs126')],
      [0.25, rank(candidate, 'stockTechReturn126')],
      [0.20, rank(candidate, 'stockTechVr20')],
      [0.20, rank(candidate, 'stockTechNegNatr20')],
    ])
    const s1Signal = !!(
      eligible &&
      mkt2 &&
      close != null &&
      close > (indicator(candidate, 'stockTechMa50') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa50') ?? -Infinity) > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa50') ?? -Infinity) > (indicator(candidate, 'stockTechMa50Ago20') ?? Infinity) &&
      close > (indicator(candidate, 'stockTechHhPrev55') ?? Infinity) &&
      (indicator(candidate, 'stockTechHighPos252') ?? 0) >= 0.80 &&
      (rank(candidate, 'stockTechRs126') ?? 0) >= 0.80 &&
      (indicator(candidate, 'stockTechVr20') ?? 0) >= 1.50
    )
    setSignalScore(raw, '01', s1Signal, s1Score, telemetry)

    const s2Score = score([
      [0.50, rank(candidate, 'stockTechMom12_1')],
      [0.30, rank(candidate, 'stockTechHighPos252')],
      [0.20, rank(candidate, 'stockTechRs126')],
    ])
    const s2Signal = !!(
      eligible &&
      mkt1 &&
      close != null &&
      close > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa100') ?? -Infinity) > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
      (indicator(candidate, 'stockTechHighPos252') ?? 0) >= 0.90 &&
      (indicator(candidate, 'stockTechMom12_1') ?? -Infinity) > 0 &&
      (rank(candidate, 'stockTechMom12_1') ?? 0) >= 0.80 &&
      (indicator(candidate, 'stockTechRs126') ?? -Infinity) > 0
    )
    setSignalScore(raw, '02', s2Signal, s2Score, telemetry)
    const s3ContractionScore = score([
      [0.50, rank(candidate, 'stockTechContract20_60')],
      [0.50, rank(candidate, 'stockTechContract10_20')],
    ])
    const s3Score = score([
      [0.35, rank(candidate, 'stockTechRs126')],
      [0.25, s3ContractionScore],
      [0.20, rank(candidate, 'stockTechDryup10_50')],
      [0.20, rank(candidate, 'stockTechVr20')],
    ])
    const s3Signal = !!(
      eligible &&
      mkt2 &&
      close != null &&
      close > (indicator(candidate, 'stockTechMa50') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa50') ?? -Infinity) > (indicator(candidate, 'stockTechMa150') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa150') ?? -Infinity) > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa200') ?? -Infinity) > (indicator(candidate, 'stockTechMa200Ago20') ?? Infinity) &&
      (indicator(candidate, 'stockTechHighPos252') ?? 0) >= 0.85 &&
      (rank(candidate, 'stockTechRs126') ?? 0) >= 0.75 &&
      (indicator(candidate, 'stockTechRangePrev20') ?? Infinity) <= 0.65 * (indicator(candidate, 'stockTechRangePrev60') ?? -Infinity) &&
      (indicator(candidate, 'stockTechRangePrev10') ?? Infinity) <= 0.75 * (indicator(candidate, 'stockTechRangePrev20') ?? -Infinity) &&
      (indicator(candidate, 'stockTechRangePrev20') ?? Infinity) <= 0.18 &&
      (indicator(candidate, 'stockTechVmaPrev10') ?? Infinity) <= 0.80 * (indicator(candidate, 'stockTechVmaPrev50') ?? -Infinity) &&
      close > (indicator(candidate, 'stockTechHhPrev20') ?? Infinity) &&
      (indicator(candidate, 'stockTechVr20') ?? 0) >= 1.50
    )
    setSignalScore(raw, '03', s3Signal, s3Score, telemetry)

    const s4Score = score([
      [0.35, rank(candidate, 'stockTechRs63')],
      [0.25, rank(candidate, 'stockTechDeduct20Raw')],
      [0.20, rank(candidate, 'stockTechVr20')],
      [0.20, rank(candidate, 'stockTechStretchHh20Atr') == null ? null : 1 - rank(candidate, 'stockTechStretchHh20Atr')!],
    ])
    const s4Signal = !!(
      eligible &&
      mkt1 &&
      close != null &&
      close > (indicator(candidate, 'stockTechMa60') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa60') ?? -Infinity) > (indicator(candidate, 'stockTechMa120') ?? Infinity) &&
      (indicator(candidate, 'stockTechDeduct20Raw') ?? -Infinity) > 0 &&
      (indicator(candidate, 'stockTechDeduct20Prev') ?? Infinity) <= 0 &&
      (indicator(candidate, 'stockTechReturn60') ?? -Infinity) > 0 &&
      close > (indicator(candidate, 'stockTechHhPrev20') ?? Infinity) &&
      (indicator(candidate, 'stockTechVr20') ?? 0) >= 1.30 &&
      (rank(candidate, 'stockTechRs63') ?? 0) >= 0.60 &&
      (indicator(candidate, 'stockTechStretchHh20Atr') ?? Infinity) <= 0.50
    )
    setSignalScore(raw, '04', s4Signal, s4Score, telemetry)
    const s5Score = score([
      [0.40, rank(candidate, 'stockTechRs63')],
      [0.25, indicator(candidate, 'stockTechS05PullbackQuality')],
      [0.20, indicator(candidate, 'stockTechS05DryupQuality')],
      [0.15, indicator(candidate, 'stockTechClv')],
    ])
    const s5Signal = !!(
      eligible &&
      mkt2 &&
      (indicator(candidate, 'stockTechS05DaysSinceBreakout') ?? -Infinity) >= 3 &&
      (indicator(candidate, 'stockTechS05DaysSinceBreakout') ?? Infinity) <= 15 &&
      close != null &&
      close > (indicator(candidate, 'stockTechMa20') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa20') ?? -Infinity) > (indicator(candidate, 'stockTechMa50') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa50') ?? -Infinity) > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
      (rank(candidate, 'stockTechRs63') ?? 0) >= 0.80 &&
      indicator(candidate, 'stockTechS05PathOk') === 1 &&
      (indicator(candidate, 'stockTechS05PullbackDd') ?? -Infinity) >= -0.12 &&
      (indicator(candidate, 'stockTechS05PullbackDd') ?? Infinity) <= -0.03 &&
      (indicator(candidate, 'stockTechS05DistMa20Atr') ?? Infinity) <= 0.50 &&
      (indicator(candidate, 'stockTechS05PullbackVolRatio') ?? Infinity) <= 0.80 &&
      indicator(candidate, 'stockTechS05Trigger') === 1
    )
    setSignalScore(raw, '05', s5Signal, s5Score, telemetry)

    const s6Score = score([
      [0.45, rank(candidate, 'stockTechRs63')],
      [0.25, rank(candidate, 'stockTechNegNatr20')],
      [0.20, rank(candidate, 'stockTechVr20')],
      [0.10, indicator(candidate, 'stockTechClv')],
    ])
    const s6Signal = !!(
      eligible &&
      mkt2 &&
      (indicator(candidate, 'stockTechPrevClose') ?? -Infinity) > (indicator(candidate, 'stockTechPrevMa20') ?? Infinity) &&
      (indicator(candidate, 'stockTechPrevMa20') ?? -Infinity) > (indicator(candidate, 'stockTechPrevMa50') ?? Infinity) &&
      (indicator(candidate, 'stockTechPrevMa50') ?? -Infinity) > (indicator(candidate, 'stockTechPrevMa200') ?? Infinity) &&
      (rank(candidate, 'stockTechRs63Prev1') ?? 0) >= 0.70 &&
      indicator(candidate, 'stockTechInsidePrev') === 1 &&
      indicator(candidate, 'stockTechNr7Prev') === 1 &&
      (indicator(candidate, 'stockTechSetupVr20') ?? Infinity) <= 0.70 &&
      close != null &&
      close > (indicator(candidate, 'stockTechPrevHigh') ?? Infinity) &&
      (indicator(candidate, 'stockTechVr20') ?? 0) >= 1.20 &&
      (indicator(candidate, 'stockTechClv') ?? 0) >= 0.70
    )
    setSignalScore(raw, '06', s6Signal, s6Score, telemetry)
    const s7Score = score([
      [0.35, rank(candidate, 'stockTechS07ReclaimStrength')],
      [0.25, rank(candidate, 'stockTechVr20Prev')],
      [0.20, rank(candidate, 'stockTechNegRsi2Prev')],
      [0.20, rank(candidate, 'stockTechRs126')],
    ])
    const s7Support = indicator(candidate, 'stockTechS07Support20Shift2')
    const s7Signal = !!(
      eligible &&
      mkt1 &&
      (indicator(candidate, 'stockTechPrev2Close') ?? -Infinity) > (indicator(candidate, 'stockTechS07Ma200Shift2') ?? Infinity) &&
      (indicator(candidate, 'stockTechS07Ma200Shift2') ?? -Infinity) > (indicator(candidate, 'stockTechS07Ma200Shift22') ?? Infinity) &&
      s7Support != null &&
      (indicator(candidate, 'stockTechPrevLow') ?? Infinity) < s7Support &&
      (indicator(candidate, 'stockTechPrevClose') ?? Infinity) < s7Support &&
      (indicator(candidate, 'stockTechS07BreakDepth') ?? -Infinity) >= 0.10 &&
      (indicator(candidate, 'stockTechS07BreakDepth') ?? Infinity) <= 1.00 &&
      (indicator(candidate, 'stockTechS07CloseBreakDepth') ?? -Infinity) > 0 &&
      (indicator(candidate, 'stockTechS07CloseBreakDepth') ?? Infinity) <= 0.75 &&
      (indicator(candidate, 'stockTechVr20Prev') ?? 0) >= 1.50 &&
      (indicator(candidate, 'stockTechRsi2Prev') ?? Infinity) <= 10 &&
      close != null && close > s7Support &&
      close > (indicator(candidate, 'stockTechLatestOpen') ?? Infinity) &&
      close > ((indicator(candidate, 'stockTechPrevHigh') ?? Infinity) + (indicator(candidate, 'stockTechPrevLow') ?? Infinity)) / 2 &&
      (indicator(candidate, 'stockTechClv') ?? 0) >= 0.70 &&
      (indicator(candidate, 'stockTechVr20') ?? 0) >= 1.00
    )
    setSignalScore(raw, '07', s7Signal, s7Score, telemetry)

    const s8Score = score([
      [0.40, rank(candidate, 'stockTechNegRsi2')],
      [0.35, rank(candidate, 'stockTechRs126')],
      [0.25, rank(candidate, 'stockTechNegVr20')],
    ])
    const s8Signal = !!(
      eligible &&
      mkt1 &&
      close != null &&
      close > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa50') ?? -Infinity) > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa200') ?? -Infinity) > (indicator(candidate, 'stockTechMa200Ago20') ?? Infinity) &&
      (indicator(candidate, 'stockTechRs126') ?? -Infinity) > 0 &&
      (indicator(candidate, 'stockTechRsi2') ?? Infinity) <= 5 &&
      (indicator(candidate, 'stockTechS08Ma5DistanceAtr') ?? -Infinity) >= 0.50 &&
      (indicator(candidate, 'stockTechVr20') ?? Infinity) < 3.00
    )
    setSignalScore(raw, '08', s8Signal, s8Score, telemetry)

    const s9Score = score([
      [0.35, rank(candidate, 'stockTechRs63')],
      [0.25, rank(candidate, 'stockTechS09Vol3Ratio')],
      [0.20, rank(candidate, 'stockTechNegS09BaseWidth')],
      [0.20, indicator(candidate, 'stockTechS09HeatQuality')],
    ])
    const s9Signal = !!(
      eligible &&
      mkt1 &&
      (indicator(candidate, 'stockTechS09BaseWidth') ?? Infinity) <= 0.15 &&
      indicator(candidate, 'stockTechS09ThreeCandles') === 1 &&
      (indicator(candidate, 'stockTechPrevClose') ?? -Infinity) > (indicator(candidate, 'stockTechPrev2Close') ?? Infinity) &&
      close != null && close > (indicator(candidate, 'stockTechPrevClose') ?? Infinity) &&
      indicator(candidate, 'stockTechS09OpensInside') === 1 &&
      (indicator(candidate, 'stockTechS09Ret3') ?? -Infinity) >= 0.03 &&
      (indicator(candidate, 'stockTechS09Ret3') ?? Infinity) <= 0.12 &&
      close > (indicator(candidate, 'stockTechS09BaseTop') ?? Infinity) &&
      close > (indicator(candidate, 'stockTechMa50') ?? Infinity) &&
      (indicator(candidate, 'stockTechMa50') ?? -Infinity) >= (indicator(candidate, 'stockTechMa50Ago10') ?? Infinity) &&
      (indicator(candidate, 'stockTechS09Vol3Ratio') ?? 0) >= 1.20
    )
    setSignalScore(raw, '09', s9Signal, s9Score, telemetry)

    const s10Score = score([
      [0.35, rank(candidate, 'stockTechVr20')],
      [0.25, rank(candidate, 'stockTechS10GapUpAtr')],
      [0.20, rank(candidate, 'stockTechS10PreDecline')],
      [0.20, indicator(candidate, 'stockTechClv')],
    ])
    const s10Signal = eligible && indicator(candidate, 'stockTechS10Trigger') === 1
    setSignalScore(raw, '10', s10Signal, s10Score, telemetry)

    const rsi2 = indicator(candidate, 'stockTechRsi2')
    const s8RiskFilterSignal = !!(
      eligible &&
      rsi2 != null &&
      rsi2 <= 10
    )
    setSignalScore(raw, '08RiskFilter', s8RiskFilterSignal, rsi2 == null ? null : 1 - rsi2 / 100, telemetry)

    const s11Score = score([      [0.35, rank(candidate, 'stockTechRs63')],
      [0.25, rank(candidate, 'stockTechVr20')],
      [0.20, indicator(candidate, 'stockTechClv')],
      [0.20, indicator(candidate, 'stockTechGapQuality')],
    ])
    const latestOpen = indicator(candidate, 'stockTechLatestOpen')
    const prevHigh = indicator(candidate, 'stockTechPrevHigh')
    const s11Signal = !!(
      eligible &&
      mkt2 &&
      (indicator(candidate, 'stockTechPrevClose') ?? -Infinity) > (indicator(candidate, 'stockTechPrevMa50') ?? Infinity) &&
      (indicator(candidate, 'stockTechPrevMa50') ?? -Infinity) > (indicator(candidate, 'stockTechPrevMa200') ?? Infinity) &&
      (rank(candidate, 'stockTechRs63') ?? 0) >= 0.80 &&
      (indicator(candidate, 'stockTechGapPct') ?? -Infinity) >= 0.01 &&
      (indicator(candidate, 'stockTechGapPct') ?? Infinity) <= 0.05 &&
      latestOpen != null &&
      prevHigh != null &&
      latestOpen > prevHigh &&
      close != null &&
      close > latestOpen &&
      close > (indicator(candidate, 'stockTechHhPrev20') ?? Infinity) &&
      (indicator(candidate, 'stockTechClv') ?? 0) >= 0.75 &&
      (indicator(candidate, 'stockTechVr20') ?? 0) >= 2.00 &&
      (indicator(candidate, 'stockTechRangeAtr') ?? Infinity) <= 2.50
    )
    setSignalScore(raw, '11', s11Signal, s11Score, telemetry)

    telemetry.materializedCount += 1
  }

  assignAdaptiveAdmissions(candidates, telemetry, [
    {
      suffix: '01',
      floorScore: 0.80,
      targetDailyMatches: 10,
      broadGate: (candidate) => {
        const closeValue = indicator(candidate, 'stockTechLatestClose') ?? finiteNumber(candidate.raw_signals?.close)
        return indicator(candidate, 'stockTechEligible') === 1 &&
          indicator(candidate, 'stockTechMarketMkt2') === 1 &&
          closeValue != null &&
          closeValue > (indicator(candidate, 'stockTechMa50') ?? Infinity) &&
          (indicator(candidate, 'stockTechMa50') ?? -Infinity) > (indicator(candidate, 'stockTechMa200') ?? Infinity)
      },
    },
    {
      suffix: '02',
      floorScore: 0.78,
      targetDailyMatches: 10,
      broadGate: (candidate) => {
        const closeValue = indicator(candidate, 'stockTechLatestClose') ?? finiteNumber(candidate.raw_signals?.close)
        return indicator(candidate, 'stockTechEligible') === 1 &&
          indicator(candidate, 'stockTechMarketMkt1') === 1 &&
          closeValue != null &&
          closeValue > (indicator(candidate, 'stockTechMa200') ?? Infinity) &&
          (indicator(candidate, 'stockTechMom12_1') ?? -Infinity) > 0
      },
    },
    {
      suffix: '04',
      floorScore: 0.76,
      targetDailyMatches: 10,
      broadGate: (candidate) => {
        const closeValue = indicator(candidate, 'stockTechLatestClose') ?? finiteNumber(candidate.raw_signals?.close)
        return indicator(candidate, 'stockTechEligible') === 1 &&
          indicator(candidate, 'stockTechMarketMkt1') === 1 &&
          closeValue != null &&
          closeValue > (indicator(candidate, 'stockTechMa60') ?? Infinity) &&
          (indicator(candidate, 'stockTechReturn60') ?? -Infinity) > 0 &&
          (indicator(candidate, 'stockTechDeduct20Raw') ?? -Infinity) > 0
      },
    },
    {
      suffix: '06',
      floorScore: 0.76,
      targetDailyMatches: 10,
      broadGate: (candidate) => {
        const closeValue = indicator(candidate, 'stockTechLatestClose') ?? finiteNumber(candidate.raw_signals?.close)
        return indicator(candidate, 'stockTechEligible') === 1 &&
          indicator(candidate, 'stockTechMarketMkt2') === 1 &&
          (indicator(candidate, 'stockTechPrevClose') ?? -Infinity) > (indicator(candidate, 'stockTechPrevMa20') ?? Infinity) &&
          (indicator(candidate, 'stockTechPrevMa20') ?? -Infinity) > (indicator(candidate, 'stockTechPrevMa50') ?? Infinity) &&
          closeValue != null &&
          closeValue > (indicator(candidate, 'stockTechPrevHigh') ?? Infinity)
      },
    },
    {
      suffix: '11',
      floorScore: 0.80,
      targetDailyMatches: 10,
      broadGate: (candidate) => {
        const closeValue = indicator(candidate, 'stockTechLatestClose') ?? finiteNumber(candidate.raw_signals?.close)
        return indicator(candidate, 'stockTechEligible') === 1 &&
          indicator(candidate, 'stockTechMarketMkt2') === 1 &&
          (indicator(candidate, 'stockTechGapPct') ?? -Infinity) >= 0 &&
          closeValue != null &&
          closeValue > (indicator(candidate, 'stockTechLatestOpen') ?? Infinity)
      },
    },
  ])

  return telemetry
}
