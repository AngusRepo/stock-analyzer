/** Canonical MACD contract: first-observation EMA seed; full signal warmup. */
export const TECHNICAL_SIGNAL_MATH_VERSION = 'macd-ema-first-seed-12-26-9-v1'

export function emaSeries(values: number[], period: number): number[] {
  if (!values.length || period <= 0) return []
  const alpha = 2 / (period + 1)
  const out = [values[0]]
  for (let i = 1; i < values.length; i++) out.push(values[i] * alpha + out[i - 1] * (1 - alpha))
  return out
}

export function macdComponents(closes: number[]): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < 35 || closes.some(value => !Number.isFinite(value))) return null
  const fast = emaSeries(closes, 12)
  const slow = emaSeries(closes, 26)
  const line = fast.map((value, index) => value - slow[index])
  const signals = emaSeries(line, 9)
  const macd = line[line.length - 1]
  const signal = signals[signals.length - 1]
  return { macd, signal, histogram: macd - signal }
}

export function macdHistogramLast(closes: number[]): number | null {
  return macdComponents(closes)?.histogram ?? null
}
