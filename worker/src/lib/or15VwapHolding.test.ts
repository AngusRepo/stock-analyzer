import { assessOr15VwapHolding, type Or15VwapHoldingAdvice } from './or15VwapHolding'

function assert(value: unknown, message: string): void { if (!value) throw new Error(message) }
const start = Date.parse('2026-10-01T09:00:00+08:00')
const closes = [100, 100, 99, 98, 101]
const bars = closes.map((close, index) => ({ startMs: start + index * 60_000,
  open: close, high: close, low: close, close, volume: 100 }))
const weak = assessOr15VwapHolding(bars.slice(0, 4), start + 4 * 60_000)
assert(weak?.reason === 'two_closes_below_review', 'two completed closes below VWAP must flag weakness')
assert(assessOr15VwapHolding(bars.slice(0, 4), start + 3 * 60_000) == null,
  'unfinished fourth bar must not produce a weakness advisory')
const reclaim: Or15VwapHoldingAdvice | null = assessOr15VwapHolding(bars, start + 5 * 60_000)
assert(reclaim?.reason === 'healthy_reclaim_hold', 'a completed VWAP reclaim must advise holding')
assert(assessOr15VwapHolding(bars, start + 8 * 60_000) == null,
  'stale minute bars must not create a new holding advisory')
