import { computeTechnicalIndicators } from './technicalIndicators'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const closes = Array.from({ length: 70 }, (_, i) => 100 + i)
  const highs = closes.map((close) => close + 1)
  const lows = closes.map((close) => close - 1)
  const indicators = computeTechnicalIndicators(closes, highs, lows)

  assert(indicators.ma5 === 167, 'ma5 should be computed from the latest 5 closes')
  assert(indicators.ma20 === 159.5, 'ma20 should be computed from the latest 20 closes')
  assert(indicators.rsi14 === 100, 'steady uptrend should produce max RSI')
  assert(indicators.atr14 === 2, 'constant high/low range should produce stable ATR')
  assert(indicators.bbUpper != null && indicators.bbLower != null, 'bollinger bands should be present with 20 closes')
}
