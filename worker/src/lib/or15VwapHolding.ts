import type { Or15Bar } from './or15VwapEntry'

export interface Or15VwapHoldingAdvice {
  reason: 'healthy_reclaim_hold' | 'two_closes_below_review'
  barCloseMs: number
  vwap: number
  close: number
}

/** Emits only completed-bar transitions; the Paper exit owner keeps TP/SL authority. */
export function assessOr15VwapHolding(bars: Or15Bar[], nowMs: number): Or15VwapHoldingAdvice | null {
  const ordered = bars.filter(bar => bar.startMs + 60_000 <= nowMs &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) &&
    bar.close > 0 && bar.volume >= 0).sort((a, b) => a.startMs - b.startMs)
  let volume = 0
  let weightedClose = 0
  const states: Array<{ bar: Or15Bar; below: boolean; vwap: number }> = []
  for (const bar of ordered) {
    volume += bar.volume
    weightedClose += bar.close * bar.volume
    if (volume > 0) states.push({ bar, below: bar.close < weightedClose / volume, vwap: weightedClose / volume })
  }
  const current = states.at(-1)
  const previous = states.at(-2)
  const before = states.at(-3)
  if (!current || !previous || current.bar.startMs - previous.bar.startMs !== 60_000) return null
  if (nowMs - (current.bar.startMs + 60_000) > 90_000) return null
  if (!current.below && previous.below) {
    return { reason: 'healthy_reclaim_hold', barCloseMs: current.bar.startMs + 60_000,
      vwap: current.vwap, close: current.bar.close }
  }
  if (current.below && previous.below && (!before || !before.below ||
      previous.bar.startMs - before.bar.startMs !== 60_000)) {
    return { reason: 'two_closes_below_review', barCloseMs: current.bar.startMs + 60_000,
      vwap: current.vwap, close: current.bar.close }
  }
  return null
}
