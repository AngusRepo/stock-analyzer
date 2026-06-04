import {
  buildIntradayFibonacciLevels,
  buildOhlcvTradePlanLevels,
  formatIntradayFibonacciWatchPoint,
  formatOhlcvTradePlanWatchPoint,
  normalizeOhlcvRows,
  resolveOhlcvEntryPlan,
} from './ohlcvTradePlanLevels'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const rows = normalizeOhlcvRows(Array.from({ length: 70 }, (_, index) => {
  const close = 100 + index
  return {
    date: `2026-03-${String((index % 28) + 1).padStart(2, '0')}`,
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    volume: index >= 50 && index <= 55 ? 10000 : 1000,
  }
}))

const levels = buildOhlcvTradePlanLevels(rows)

assert(levels != null, 'backend should compute trade plan levels from OHLCV rows')
assert(levels!.support > 140 && levels!.support < levels!.latestClose, 'backend support must use an actionable recent swing low, not the full-window floor')
assert(levels!.resistance === 170, 'backend resistance must use the prior high before the latest candle')
assert(levels!.confirmation > levels!.resistance, 'backend confirmation must be a buffered trigger above prior-high pressure')
assert(levels!.volumeNode != null && levels!.volumeNode > 145 && levels!.volumeNode < 165, 'backend volume node must come from OHLCV volume distribution')
assert(levels!.atrLower != null && levels!.atrLower < levels!.latestClose, 'backend ATR defense must come from OHLCV ATR')

const breakoutPlan = resolveOhlcvEntryPlan(levels!, { latestPrice: levels!.confirmation + 0.1 })

assert(breakoutPlan?.source === 'ohlcv', 'resolved backend entry plan should declare OHLCV source')
assert(breakoutPlan?.mode === 'breakout', 'price above confirmation should use breakout mode')
assert(breakoutPlan?.entryPrice === levels!.confirmation, 'breakout entry must use buffered OHLCV confirmation, not model close')
assert(breakoutPlan!.target1 > breakoutPlan!.entryPrice, 'breakout target1 must sit above the buffered entry trigger')
assert(breakoutPlan?.optimisticLow === levels!.confirmation, 'optimistic range low must be OHLCV confirmation')
assert(breakoutPlan!.optimisticHigh >= round2(levels!.confirmation * 1.018), 'optimistic range high must not sit below the strong breakout chase ceiling')
assert(
  breakoutPlan!.buyReferenceHigh - breakoutPlan!.buyReferenceLow <= Math.max(3, breakoutPlan!.buyReferenceLow * 0.025),
  'buy reference zone must be an actionable band, not support-to-volume-node across the whole box',
)

const watchPoint = formatOhlcvTradePlanWatchPoint(breakoutPlan!)

assert(watchPoint.startsWith('ohlcv_trade_plan:'), 'OHLCV backend plan should be persisted as a watch point')
assert(watchPoint.includes('buy_reference='), 'watch point should expose buy reference zone')
assert(watchPoint.includes(`optimistic_range=${breakoutPlan!.optimisticLow}~${breakoutPlan!.optimisticHigh}`), 'watch point should expose OHLCV optimistic range')
assert(!watchPoint.includes('fair_value'), 'watch point must not expose fair value as a trading line')

const futuresNightRows = normalizeOhlcvRows([
  { date: '2026-05-25', time: 145900, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
  { date: '2026-05-25', time: 150000, open: 100, high: 104, low: 98, close: 102, volume: 1000 },
  { date: '2026-05-25', time: 233000, open: 102, high: 110, low: 97, close: 108, volume: 1000 },
  { date: '2026-05-26', time: '003000', open: 108, high: 109, low: 90, close: 95, volume: 1000 },
  { date: '2026-05-26', time: '091500', open: 95, high: 106, low: 94, close: 105, volume: 1000 },
  { date: '2026-05-26', time: 134500, open: 105, high: 107, low: 95, close: 106, volume: 1000 },
])

const futuresFib = buildIntradayFibonacciLevels(futuresNightRows, {
  sessionMode: 'tw_futures_night_session',
  nightStartTime: 150000,
})

assert(futuresFib?.sessionKey === '2026-05-26', 'futures session should group T-1 15:00 through T day session')
assert(futuresFib?.sessionHigh === 110, 'futures fib high should include prior-night high')
assert(futuresFib?.sessionLow === 90, 'futures fib low should include after-midnight low in the same trading session')
assert(futuresFib?.fib50 === 100, 'futures fib 50% should come from complete trading-session range')
assert(futuresFib?.fib618 === 102.36, 'futures fib 61.8% should come from complete trading-session range')

const calendarFib = buildIntradayFibonacciLevels(futuresNightRows, { sessionMode: 'calendar_day' })

assert(calendarFib?.sessionHigh === 109, 'calendar mode should not include prior natural-day night high')
assert(calendarFib?.sessionLow === 90, 'calendar mode should use only the latest natural day')

const fibWatchPoint = formatIntradayFibonacciWatchPoint(futuresFib!)

assert(fibWatchPoint.startsWith('intraday_fibonacci:'), 'fibonacci levels should be a distinct execution watch point')
assert(fibWatchPoint.includes('fib50=100'), 'fibonacci watch point should expose 50% level')
assert(fibWatchPoint.includes('fib618=102.36'), 'fibonacci watch point should expose 61.8% level')

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
