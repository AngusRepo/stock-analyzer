/** Closed-minute opening-range entry permission for the Paper account. */
export interface Or15Bar {
  startMs: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Or15VwapDecision {
  action: 'pass' | 'defer'
  reason: string
  signalMs: number | null
  orHigh: number | null
  orLow: number | null
  vwap: number | null
  latestBarMs: number | null
}

const MINUTE_MS = 60_000
const TW_OFFSET_MS = 8 * 60 * MINUTE_MS

function twDate(ms: number): string {
  return new Date(ms + TW_OFFSET_MS).toISOString().slice(0, 10)
}

function wait(reason: string, values: Partial<Or15VwapDecision> = {}): Or15VwapDecision {
  return { action: 'defer', reason, signalMs: null, orHigh: null, orLow: null, vwap: null, latestBarMs: null, ...values }
}

export function assessOr15VwapEntry(input: {
  bars: Or15Bar[]
  tradeDate: string
  nowMs: number
  maxBarAgeMs?: number
  maxSignalAgeMs?: number
}): Or15VwapDecision {
  const openMs = Date.parse(`${input.tradeDate}T09:00:00+08:00`)
  if (!Number.isFinite(openMs)) return wait('or15_invalid_trade_date')
  if (input.nowMs > openMs + 151 * MINUTE_MS) return wait('or15_entry_window_closed')
  const byMinute = new Map<number, Or15Bar>()
  for (const bar of input.bars) {
    if (twDate(bar.startMs) !== input.tradeDate || bar.startMs < openMs || bar.startMs > openMs + 270 * MINUTE_MS) continue
    if (bar.startMs + MINUTE_MS > input.nowMs ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
      bar.low <= 0 || bar.high < bar.low || bar.volume < 0) continue
    byMinute.set(bar.startMs, bar)
  }
  // Both start-labelled 09:00 and end-labelled 09:01 feeds exist. Use one
  // authoritative feed per call; do not merge event-derived partial bars here.
  const firstMs = byMinute.has(openMs) ? openMs : openMs + MINUTE_MS
  const opening = Array.from({ length: 15 }, (_, index) => byMinute.get(firstMs + index * MINUTE_MS))
  if (opening.some(bar => bar == null)) return wait('or15_opening_bars_missing')
  const first = opening as Or15Bar[]
  const orHigh = Math.max(...first.map(bar => bar.high))
  const orLow = Math.min(...first.map(bar => bar.low))
  const bars = [...byMinute.values()].filter(bar => bar.startMs >= firstMs).sort((a, b) => a.startMs - b.startMs)
  const latest = bars.at(-1)!
  const context = { orHigh, orLow, latestBarMs: latest.startMs }
  if (input.nowMs - (latest.startMs + MINUTE_MS) > (input.maxBarAgeMs ?? 90_000)) {
    return wait('or15_minute_bars_stale', context)
  }
  if (latest.startMs > firstMs + 15 * MINUTE_MS &&
    !byMinute.has(latest.startMs - MINUTE_MS)) return wait('or15_latest_bar_gap', context)

  let totalVolume = 0
  let weightedClose = 0
  let previous: Or15Bar | null = null
  let signalMs: number | null = null
  let latestVwap: number | null = null
  for (const bar of bars) {
    totalVolume += bar.volume
    weightedClose += bar.close * bar.volume
    const vwap = totalVolume > 0 ? weightedClose / totalVolume : null
    if (bar.startMs === latest.startMs) latestVwap = vwap
    const minutesAfterOpening = (bar.startMs - firstMs) / MINUTE_MS
    if (signalMs == null && minutesAfterOpening >= 15 && bar.startMs <= openMs + 150 * MINUTE_MS &&
      previous && bar.startMs - previous.startMs === MINUTE_MS && vwap != null &&
      previous.close <= orHigh && bar.close > orHigh && bar.close > vwap) {
      signalMs = bar.startMs + MINUTE_MS
    }
    previous = bar
  }
  if (signalMs == null) return wait('or15_waiting_breakout', { ...context, vwap: latestVwap })
  if (input.nowMs - signalMs > (input.maxSignalAgeMs ?? 180_000)) {
    return wait('or15_signal_expired', { ...context, signalMs, vwap: latestVwap })
  }
  if (latestVwap == null || latest.close <= orHigh || latest.close <= latestVwap) {
    return wait('or15_breakout_lost', { ...context, signalMs, vwap: latestVwap })
  }
  return { action: 'pass', reason: 'or15_vwap_breakout', signalMs, ...context, vwap: latestVwap }
}
