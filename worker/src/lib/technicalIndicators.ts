export interface TechnicalIndicatorResult {
  ma5: number | null
  ma10: number | null
  ma20: number | null
  ma60: number | null
  rsi14: number | null
  macd: number | null
  macdSignal: number | null
  macdHist: number | null
  bbUpper: number | null
  bbMid: number | null
  bbLower: number | null
  atr14: number | null
  plusDi14: number | null
  minusDi14: number | null
  adx14: number | null
  parabolicSar: number | null
  cci20: number | null
  volumeWeightedRsi14: number | null
  volumeMomentumDivergence132710: number | null
  squeezeOn: number | null
  squeezeRelease: number | null
  squeezeMomentum: number | null
  obvTemperature60: number | null
  adaptiveRsiMidline50: number | null
  adaptiveRsiUpper50: number | null
  adaptiveRsiLower50: number | null
  adaptiveRsiOverbought: number | null
  adaptiveRsiOversold: number | null
}

function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n
}

function ema(arr: number[], n: number): number[] {
  const k = 2 / (n + 1)
  const result = [arr[0]]
  for (let i = 1; i < arr.length; i++) result.push(arr[i] * k + result[i - 1] * (1 - k))
  return result
}

function round4(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10000) / 10000
}

function stddev(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)
}

function trueRangeAt(highs: number[], lows: number[], closes: number[], index: number): number {
  if (index <= 0) return highs[index] - lows[index]
  return Math.max(
    highs[index] - lows[index],
    Math.abs(highs[index] - closes[index - 1]),
    Math.abs(lows[index] - closes[index - 1]),
  )
}

function computeDmiAdx(
  closes: number[],
  highs: number[],
  lows: number[],
  period = 14,
): { plusDi: number | null; minusDi: number | null; adx: number | null } {
  if (closes.length < period + 1 || highs.length < period + 1 || lows.length < period + 1) {
    return { plusDi: null, minusDi: null, adx: null }
  }

  const plusDm: number[] = []
  const minusDm: number[] = []
  const tr: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1]
    const downMove = lows[i - 1] - lows[i]
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0)
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ))
  }

  let smoothPlusDm = plusDm.slice(0, period).reduce((sum, value) => sum + value, 0)
  let smoothMinusDm = minusDm.slice(0, period).reduce((sum, value) => sum + value, 0)
  let smoothTr = tr.slice(0, period).reduce((sum, value) => sum + value, 0)
  const dxValues: number[] = []
  let latestPlusDi = 0
  let latestMinusDi = 0

  for (let i = period; i <= tr.length; i++) {
    if (i > period) {
      const idx = i - 1
      smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDm[idx]
      smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDm[idx]
      smoothTr = smoothTr - smoothTr / period + tr[idx]
    }
    latestPlusDi = smoothTr > 0 ? (smoothPlusDm / smoothTr) * 100 : 0
    latestMinusDi = smoothTr > 0 ? (smoothMinusDm / smoothTr) * 100 : 0
    const denom = latestPlusDi + latestMinusDi
    dxValues.push(denom > 0 ? (Math.abs(latestPlusDi - latestMinusDi) / denom) * 100 : 0)
  }

  if (dxValues.length === 0) return { plusDi: latestPlusDi, minusDi: latestMinusDi, adx: null }
  if (dxValues.length < period) {
    return { plusDi: latestPlusDi, minusDi: latestMinusDi, adx: dxValues[dxValues.length - 1] }
  }

  let adx = dxValues.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  for (let i = period; i < dxValues.length; i++) {
    adx = ((adx * (period - 1)) + dxValues[i]) / period
  }
  return { plusDi: latestPlusDi, minusDi: latestMinusDi, adx }
}

function computeParabolicSar(highs: number[], lows: number[], closes: number[]): number | null {
  if (highs.length < 2 || lows.length < 2 || closes.length < 2) return null
  const step = 0.02
  const maxAf = 0.2
  let uptrend = closes[1] >= closes[0]
  let sar = uptrend ? lows[0] : highs[0]
  let ep = uptrend ? highs[1] : lows[1]
  let af = step

  for (let i = 1; i < closes.length; i++) {
    sar = sar + af * (ep - sar)
    if (uptrend) {
      sar = Math.min(sar, lows[i - 1], i >= 2 ? lows[i - 2] : lows[i - 1])
      if (lows[i] < sar) {
        uptrend = false
        sar = ep
        ep = lows[i]
        af = step
      } else if (highs[i] > ep) {
        ep = highs[i]
        af = Math.min(maxAf, af + step)
      }
    } else {
      sar = Math.max(sar, highs[i - 1], i >= 2 ? highs[i - 2] : highs[i - 1])
      if (highs[i] > sar) {
        uptrend = true
        sar = ep
        ep = highs[i]
        af = step
      } else if (lows[i] < ep) {
        ep = lows[i]
        af = Math.min(maxAf, af + step)
      }
    }
  }
  return sar
}

function computeCci(highs: number[], lows: number[], closes: number[], period = 20): number | null {
  if (highs.length < period || lows.length < period || closes.length < period) return null
  const typical = closes.map((close, i) => (highs[i] + lows[i] + close) / 3)
  const slice = typical.slice(-period)
  const mean = slice.reduce((sum, value) => sum + value, 0) / period
  const meanDeviation = slice.reduce((sum, value) => sum + Math.abs(value - mean), 0) / period
  if (meanDeviation <= 1e-9) return 0
  return (slice[slice.length - 1] - mean) / (0.015 * meanDeviation)
}

function computeVolumeWeightedRsi(closes: number[], volumes: number[], period = 14): number | null {
  if (closes.length < period + 1 || volumes.length < closes.length) return null
  let weightedGain = 0
  let weightedLoss = 0
  let totalWeight = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1]
    const weight = Math.max(0, volumes[i] ?? 0)
    totalWeight += weight
    if (delta > 0) weightedGain += delta * weight
    else weightedLoss += -delta * weight
  }
  if (totalWeight <= 0) return null
  const avgGain = weightedGain / totalWeight
  const avgLoss = weightedLoss / totalWeight
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

function computeRsiAt(closes: number[], endIndex: number, period = 14): number | null {
  if (endIndex < period || endIndex >= closes.length) return null
  let gains = 0
  let losses = 0
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const delta = closes[i] - closes[i - 1]
    if (delta > 0) gains += delta
    else losses -= delta
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

function computeAdaptiveRsiBands(
  closes: number[],
  rsiPeriod = 14,
  bandLength = 50,
  mult = 2,
): {
  midline: number | null
  upper: number | null
  lower: number | null
  overbought: number | null
  oversold: number | null
} {
  if (closes.length < rsiPeriod + bandLength) {
    return { midline: null, upper: null, lower: null, overbought: null, oversold: null }
  }
  const values: number[] = []
  for (let endIndex = closes.length - bandLength; endIndex < closes.length; endIndex++) {
    const value = computeRsiAt(closes, endIndex, rsiPeriod)
    if (value == null) return { midline: null, upper: null, lower: null, overbought: null, oversold: null }
    values.push(value)
  }
  const midline = values.reduce((sum, value) => sum + value, 0) / values.length
  const deviation = stddev(values)
  const upper = midline + mult * deviation
  const lower = midline - mult * deviation
  const latest = values[values.length - 1]
  return {
    midline,
    upper,
    lower,
    overbought: latest > upper ? 1 : 0,
    oversold: latest < lower ? 1 : 0,
  }
}

function computeVolumeMomentumDivergence(volumes: number[]): number | null {
  const shortPeriod = 13
  const longPeriod = 27
  const signalPeriod = 10
  if (volumes.length < longPeriod + signalPeriod - 1) return null
  const diffs: number[] = []
  for (let end = longPeriod; end <= volumes.length; end++) {
    const window = volumes.slice(0, end)
    const short = sma(window, shortPeriod)
    const long = sma(window, longPeriod)
    if (short != null && long != null) diffs.push(short - long)
  }
  if (diffs.length < signalPeriod) return null
  const latest = diffs[diffs.length - 1]
  const signal = diffs.slice(-signalPeriod).reduce((sum, value) => sum + value, 0) / signalPeriod
  return latest - signal
}

function linearRegressionForecast(values: number[]): number | null {
  const n = values.length
  if (n === 0) return null
  const meanX = (n - 1) / 2
  const meanY = values.reduce((sum, value) => sum + value, 0) / n
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i++) {
    const dx = i - meanX
    numerator += dx * (values[i] - meanY)
    denominator += dx * dx
  }
  const slope = denominator > 0 ? numerator / denominator : 0
  const intercept = meanY - slope * meanX
  return intercept + slope * (n - 1)
}

function computeSqueezeMomentum(
  closes: number[],
  highs: number[],
  lows: number[],
  endExclusive: number,
  period = 20,
): number | null {
  if (endExclusive < period * 2 - 1) return null
  const values: number[] = []
  for (let index = endExclusive - period; index < endExclusive; index++) {
    const start = index - period + 1
    const closeSlice = closes.slice(start, index + 1)
    const highSlice = highs.slice(start, index + 1)
    const lowSlice = lows.slice(start, index + 1)
    const highest = Math.max(...highSlice)
    const lowest = Math.min(...lowSlice)
    const meanClose = closeSlice.reduce((sum, value) => sum + value, 0) / period
    const anchor = ((highest + lowest) / 2 + meanClose) / 2
    values.push(closes[index] - anchor)
  }
  return linearRegressionForecast(values)
}

function computeTtmSqueeze(
  closes: number[],
  highs: number[],
  lows: number[],
  period = 20,
  multBB = 2,
  multKC = 1.5,
): { squeezeOn: number | null; squeezeRelease: number | null; squeezeMomentum: number | null } {
  function snapshot(endExclusive: number): { on: boolean; off: boolean } | null {
    if (endExclusive < period || highs.length < endExclusive || lows.length < endExclusive) return null
    const closeSlice = closes.slice(endExclusive - period, endExclusive)
    const mid = closeSlice.reduce((sum, value) => sum + value, 0) / period
    const deviation = stddev(closeSlice)
    const bbUpper = mid + multBB * deviation
    const bbLower = mid - multBB * deviation
    const trueRanges: number[] = []
    for (let i = endExclusive - period; i < endExclusive; i++) {
      trueRanges.push(trueRangeAt(highs, lows, closes, i))
    }
    const range = trueRanges.reduce((sum, value) => sum + value, 0) / period
    const kcUpper = mid + multKC * range
    const kcLower = mid - multKC * range
    return {
      on: bbUpper < kcUpper && bbLower > kcLower,
      off: bbUpper > kcUpper && bbLower < kcLower,
    }
  }

  const current = snapshot(closes.length)
  if (!current) return { squeezeOn: null, squeezeRelease: null, squeezeMomentum: null }
  const previous = snapshot(closes.length - 1)
  return {
    squeezeOn: current.on ? 1 : 0,
    squeezeRelease: previous?.on && current.off ? 1 : 0,
    squeezeMomentum: computeSqueezeMomentum(closes, highs, lows, closes.length, period),
  }
}

function computeObvTemperature(closes: number[], volumes: number[], period = 60): number | null {
  if (closes.length < period || volumes.length < closes.length) return null
  const obv: number[] = [0]
  for (let i = 1; i < closes.length; i++) {
    const volume = Math.max(0, Number(volumes[i] ?? 0))
    const direction = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0
    obv.push(obv[i - 1] + direction * volume)
  }
  const window = obv.slice(-period)
  const high = Math.max(...window)
  const low = Math.min(...window)
  if (high <= low) return null
  return ((obv[obv.length - 1] - low) / (high - low)) * 100
}

export function computeTechnicalIndicators(
  closes: number[],
  highs: number[],
  lows: number[],
  volumes: number[] = [],
): TechnicalIndicatorResult {
  const ma5 = sma(closes, 5)
  const ma10 = sma(closes, 10)
  const ma20 = sma(closes, 20)
  const ma60 = sma(closes, 60)

  let rsi14: number | null = null
  const period = 14
  if (closes.length >= period + 1) {
    let gains = 0
    let losses = 0
    for (let i = closes.length - period; i < closes.length; i++) {
      const delta = closes[i] - closes[i - 1]
      if (delta > 0) gains += delta
      else losses -= delta
    }
    const avgGain = gains / period
    const avgLoss = losses / period
    rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }

  let macd: number | null = null
  let macdSignal: number | null = null
  let macdHist: number | null = null
  if (closes.length >= 35) {
    const ema12 = ema(closes, 12)
    const ema26 = ema(closes, 26)
    const macdLine = ema12.map((v, i) => v - ema26[i]).slice(25)
    const signalLine = ema(macdLine, 9)
    macd = macdLine[macdLine.length - 1]
    macdSignal = signalLine[signalLine.length - 1]
    macdHist = macd - macdSignal
  }

  let bbUpper: number | null = null
  let bbMid: number | null = null
  let bbLower: number | null = null
  if (closes.length >= 20) {
    const slice = closes.slice(-20)
    const mean = slice.reduce((a, b) => a + b, 0) / 20
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20)
    bbMid = mean
    bbUpper = mean + 2 * std
    bbLower = mean - 2 * std
  }

  let atr14: number | null = null
  if (highs.length >= 15 && lows.length >= 15 && closes.length >= 15) {
    const trueRanges: number[] = []
    for (let i = highs.length - 14; i < highs.length; i++) {
      trueRanges.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ))
    }
    atr14 = trueRanges.reduce((a, b) => a + b, 0) / 14
  }

  const dmi = computeDmiAdx(closes, highs, lows, 14)
  const parabolicSar = computeParabolicSar(highs, lows, closes)
  const cci20 = computeCci(highs, lows, closes, 20)
  const volumeWeightedRsi14 = computeVolumeWeightedRsi(closes, volumes, 14)
  const volumeMomentumDivergence132710 = computeVolumeMomentumDivergence(volumes)
  const squeeze = computeTtmSqueeze(closes, highs, lows)
  const obvTemperature60 = computeObvTemperature(closes, volumes, 60)
  const adaptiveRsi = computeAdaptiveRsiBands(closes, 14, 50, 2)

  return {
    ma5,
    ma10,
    ma20,
    ma60,
    rsi14,
    macd,
    macdSignal,
    macdHist,
    bbUpper,
    bbMid,
    bbLower,
    atr14,
    plusDi14: round4(dmi.plusDi),
    minusDi14: round4(dmi.minusDi),
    adx14: round4(dmi.adx),
    parabolicSar: round4(parabolicSar),
    cci20: round4(cci20),
    volumeWeightedRsi14: round4(volumeWeightedRsi14),
    volumeMomentumDivergence132710: round4(volumeMomentumDivergence132710),
    squeezeOn: squeeze.squeezeOn,
    squeezeRelease: squeeze.squeezeRelease,
    squeezeMomentum: round4(squeeze.squeezeMomentum),
    obvTemperature60: round4(obvTemperature60),
    adaptiveRsiMidline50: round4(adaptiveRsi.midline),
    adaptiveRsiUpper50: round4(adaptiveRsi.upper),
    adaptiveRsiLower50: round4(adaptiveRsi.lower),
    adaptiveRsiOverbought: adaptiveRsi.overbought,
    adaptiveRsiOversold: adaptiveRsi.oversold,
  }
}

export async function computeAndStoreIndicators(db: D1Database, stockId: number, asOfDate?: string): Promise<void> {
  try {
    const recentPrices = asOfDate
      ? await db.prepare(
        'SELECT date, close, high, low, volume FROM stock_prices WHERE stock_id=? AND date<=? ORDER BY date DESC LIMIT 70',
      ).bind(stockId, asOfDate).all<{ date: string; close: number; high: number | null; low: number | null; volume?: number | null }>()
      : await db.prepare(
        'SELECT date, close, high, low, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 70',
      ).bind(stockId).all<{ date: string; close: number; high: number | null; low: number | null; volume?: number | null }>()

    const rows = (recentPrices.results ?? []).filter((p) => Number(p.close) > 0)
    const latestDate = rows[0]?.date
    if (!latestDate) return
    const closes = rows.map((p) => Number(p.close)).reverse()
    if (closes.length < 20) return

    const indicators = computeTechnicalIndicators(
      closes,
      rows.map((p) => Number(p.high ?? p.close)).reverse(),
      rows.map((p) => Number(p.low ?? p.close)).reverse(),
      rows.map((p) => Number(p.volume ?? 0)).reverse(),
    )
    await db.prepare(
      `INSERT OR REPLACE INTO technical_indicators
         (stock_id, date, ma5, ma10, ma20, ma60, rsi14, macd, macd_signal, macd_hist,
          bb_upper, bb_mid, bb_lower, atr14, plus_di14, minus_di14, adx14, parabolic_sar,
          cci20, volume_weighted_rsi14, volume_momentum_divergence_13_27_10,
          squeeze_on, squeeze_release, squeeze_momentum, obv_temperature_60,
          adaptive_rsi_midline_50, adaptive_rsi_upper_50, adaptive_rsi_lower_50,
          adaptive_rsi_overbought, adaptive_rsi_oversold)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      stockId,
      latestDate,
      indicators.ma5,
      indicators.ma10,
      indicators.ma20,
      indicators.ma60,
      indicators.rsi14,
      indicators.macd,
      indicators.macdSignal,
      indicators.macdHist,
      indicators.bbUpper,
      indicators.bbMid,
      indicators.bbLower,
      indicators.atr14,
      indicators.plusDi14,
      indicators.minusDi14,
      indicators.adx14,
      indicators.parabolicSar,
      indicators.cci20,
      indicators.volumeWeightedRsi14,
      indicators.volumeMomentumDivergence132710,
      indicators.squeezeOn,
      indicators.squeezeRelease,
      indicators.squeezeMomentum,
      indicators.obvTemperature60,
      indicators.adaptiveRsiMidline50,
      indicators.adaptiveRsiUpper50,
      indicators.adaptiveRsiLower50,
      indicators.adaptiveRsiOverbought,
      indicators.adaptiveRsiOversold,
    ).run()
  } catch (error) {
    console.error(`[Indicators] Failed for stock_id=${stockId}:`, error)
  }
}
