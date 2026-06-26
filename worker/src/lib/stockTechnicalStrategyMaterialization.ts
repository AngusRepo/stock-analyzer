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
  method: 'stock_technical_strategy12_daily_materialization_v1'
  universeCount: number
  materializedCount: number
  scoreCoverage: Record<string, number>
  signalCoverage: Record<string, number>
  marketRegime: StockTechnicalMarketRegime | null
  unsupported: {
    stockTechS12Score: 'requires_intraday_15m_1h_4h'
  }
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

function safeRatio(numerator: NullableNumber, denominator: NullableNumber): number | null {
  const n = finiteNumber(numerator)
  const d = finiteNumber(denominator)
  if (n == null || d == null || Math.abs(d) <= 1e-12) return null
  return n / d
}

function atrAt(bars: CleanStockTechnicalDailyBar[], period: number): number | null {
  if (bars.length < period + 1) return null
  const end = bars.length
  const start = end - period
  const trueRanges: number[] = []
  for (let index = start; index < end; index += 1) {
    const row = bars[index]
    const prevClose = finiteNumber(bars[index - 1]?.close)
    if (prevClose == null) return null
    trueRanges.push(Math.max(
      row.high - row.low,
      Math.abs(row.high - prevClose),
      Math.abs(row.low - prevClose),
    ))
  }
  return avg(trueRanges)
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
  const stretch = hhPrev20 == null ? null : safeRatio(latest.close - hhPrev20, atr14)

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
    stockTechRangePrev10: rangePrev(10),
    stockTechRangePrev20: rangePrev(20),
    stockTechRangePrev60: rangePrev(60),
    stockTechHighPos252: highPos252,
    stockTechReturn63: pctChange(latest.close, closeShift(63)),
    stockTechReturn60: pctChange(latest.close, closeShift(60)),
    stockTechReturn126: pctChange(latest.close, closeShift(126)),
    stockTechReturn252: pctChange(latest.close, closeShift(252)),
    stockTechReturn63Prev1: pctChange(prevClose, closeShift(64)),
    stockTechMom12_1: pctChange(closeShift(21), closeShift(252)),
    stockTechAtr14: atr14,
    stockTechAtr20: atr20,
    stockTechNatr20: natr20,
    stockTechVr20: safeRatio(latest.volume, vmaPrev20),
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
  telemetry.scoreCoverage[scoreKey] = (telemetry.scoreCoverage[scoreKey] ?? 0) + 1
  if (signal) telemetry.signalCoverage[signalKey] = (telemetry.signalCoverage[signalKey] ?? 0) + 1
}

export function materializeStockTechnicalStrategyScores<T extends StockTechnicalMaterializationCandidate>(
  candidates: T[],
  options: { marketRegime?: StockTechnicalMarketRegime | null } = {},
): StockTechnicalStrategyMaterializationTelemetry {
  const telemetry: StockTechnicalStrategyMaterializationTelemetry = {
    method: 'stock_technical_strategy12_daily_materialization_v1',
    universeCount: candidates.length,
    materializedCount: 0,
    scoreCoverage: {},
    signalCoverage: {},
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

    const s11Score = score([
      [0.35, rank(candidate, 'stockTechRs63')],
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

  return telemetry
}
