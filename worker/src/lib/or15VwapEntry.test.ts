import { assessOr15VwapEntry, type Or15Bar } from './or15VwapEntry'

function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message)
}

const open = Date.parse('2026-08-03T09:01:00+08:00')
const bars: Or15Bar[] = Array.from({ length: 20 }, (_, index) => ({
  startMs: open + index * 60_000,
  open: 100,
  high: index < 15 ? 101 : 103,
  low: 99,
  close: index < 15 ? 100 : index === 15 ? 102 : 102.5,
  volume: 100,
}))
const decision = assessOr15VwapEntry({ bars, tradeDate: '2026-08-03', nowMs: open + 17 * 60_000 })
assert(decision.action === 'pass' && decision.signalMs === open + 16 * 60_000, 'closed OR15 breakout must be available without S12 maturity')
assert(decision.orLow === 99 && decision.orHigh === 101, 'opening range must preserve its structural stop')
assert(assessOr15VwapEntry({ bars: bars.slice(0, 15), tradeDate: '2026-08-03', nowMs: open + 15 * 60_000 }).action === 'defer', 'do not use future breakout bars')
assert(assessOr15VwapEntry({ bars: bars.slice(1), tradeDate: '2026-08-03', nowMs: open + 20 * 60_000 }).reason === 'or15_opening_bars_missing', 'missing open must fail closed')
assert(assessOr15VwapEntry({ bars, tradeDate: '2026-08-03', nowMs: open + 25 * 60_000 }).reason === 'or15_minute_bars_stale', 'stale bars must not create Paper orders')
assert(assessOr15VwapEntry({ bars, tradeDate: '2026-08-03', nowMs: open + 20 * 60_000 }).reason === 'or15_signal_expired', 'a delayed run must not chase an old breakout')
assert(assessOr15VwapEntry({ bars, tradeDate: '2026-08-03', nowMs: Date.parse('2026-08-03T11:32:00+08:00') }).reason === 'or15_minute_bars_stale', 'after 11:31, stale data must still be rejected for its actual reason')

function firstBreakoutAt(time: string): Or15Bar[] {
  const breakoutMs = Date.parse(`2026-08-03T${time}+08:00`)
  return Array.from({ length: (breakoutMs - open) / 60_000 + 1 }, (_, index) => ({
    startMs: open + index * 60_000,
    open: 100,
    high: open + index * 60_000 === breakoutMs ? 103 : 101,
    low: 99,
    close: open + index * 60_000 === breakoutMs ? 102 : 100,
    volume: 100,
  }))
}

for (const time of ['11:30:00', '11:31:00', '12:00:00', '13:29:00']) {
  const lateBars = firstBreakoutAt(time)
  const signalMs = lateBars.at(-1)!.startMs + 60_000
  const lateDecision = assessOr15VwapEntry({ bars: lateBars, tradeDate: '2026-08-03', nowMs: signalMs })
  assert(lateDecision.action === 'pass' && lateDecision.signalMs === signalMs,
    `fresh ${time} breakout must be evaluated throughout the existing market session`)
}
assert(assessOr15VwapEntry({
  bars: firstBreakoutAt('13:29:00'), tradeDate: '2026-08-03', nowMs: Date.parse('2026-08-03T13:31:00+08:00'),
}).reason === 'or15_entry_window_closed', 'a fresh signal must not bypass the existing market close')

for (const time of ['09:25:00', '12:00:00', '13:29:00']) {
  const second = firstBreakoutAt(time)
  second[15] = { ...second[15], high: 103, close: 102 }
  const signalMs = second.at(-1)!.startMs + 60_000
  const next = assessOr15VwapEntry({ bars: second, tradeDate: '2026-08-03', nowMs: signalMs })
  assert(next.action === 'pass' && next.signalMs === signalMs,
    `fresh second crossover at ${time} must replace the expired first crossover`)
  const ongoing = [...second, { ...second.at(-1)!, startMs: signalMs, close: 102.5 }]
  assert(assessOr15VwapEntry({ bars: ongoing, tradeDate: '2026-08-03', nowMs: signalMs }).signalMs === signalMs,
    'an unfinished strong bar must not change signal time')
}

const lost = [...bars.slice(0, 17), { ...bars[17], close: 100 }]
assert(assessOr15VwapEntry({ bars: lost, tradeDate: '2026-08-03', nowMs: open + 18 * 60_000 }).reason === 'or15_breakout_lost',
  'a fresh signal must still defer if the breakout is lost')
