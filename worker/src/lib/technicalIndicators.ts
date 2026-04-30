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

export function computeTechnicalIndicators(closes: number[], highs: number[], lows: number[]): TechnicalIndicatorResult {
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

  return { ma5, ma10, ma20, ma60, rsi14, macd, macdSignal, macdHist, bbUpper, bbMid, bbLower, atr14 }
}

export async function computeAndStoreIndicators(db: D1Database, stockId: number): Promise<void> {
  try {
    const recentPrices = await db.prepare(
      'SELECT close, high, low FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 70',
    ).bind(stockId).all<{ close: number; high: number; low: number }>()

    const closes = recentPrices.results.map((p) => p.close).reverse()
    if (closes.length < 20) return

    const today = new Date().toISOString().split('T')[0]
    const indicators = computeTechnicalIndicators(
      closes,
      recentPrices.results.map((p) => p.high).reverse(),
      recentPrices.results.map((p) => p.low).reverse(),
    )
    await db.prepare(
      `INSERT OR REPLACE INTO technical_indicators
         (stock_id, date, ma5, ma10, ma20, ma60, rsi14, macd, macd_signal, macd_hist, bb_upper, bb_mid, bb_lower, atr14)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      stockId,
      today,
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
    ).run()
  } catch (error) {
    console.error(`[Indicators] Failed for stock_id=${stockId}:`, error)
  }
}
