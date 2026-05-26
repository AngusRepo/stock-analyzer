import {
  buildOhlcvTradePlanLevels,
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
assert(levels!.support === 107, 'backend support must come from OHLCV swing low')
assert(levels!.resistance === 171, 'backend resistance must come from OHLCV previous high structure')
assert(levels!.confirmation === 170, 'backend confirmation must use the prior high before the latest candle')
assert(levels!.volumeNode != null && levels!.volumeNode > 145 && levels!.volumeNode < 165, 'backend volume node must come from OHLCV volume distribution')
assert(levels!.atrLower != null && levels!.atrLower < levels!.latestClose, 'backend ATR defense must come from OHLCV ATR')

const breakoutPlan = resolveOhlcvEntryPlan(levels!, { latestPrice: 170.5 })

assert(breakoutPlan?.source === 'ohlcv', 'resolved backend entry plan should declare OHLCV source')
assert(breakoutPlan?.mode === 'breakout', 'price above confirmation should use breakout mode')
assert(breakoutPlan?.entryPrice === 170, 'breakout entry must use OHLCV confirmation, not model close')
assert(breakoutPlan?.target1 === 171, 'breakout target1 must use OHLCV resistance')
assert(breakoutPlan?.optimisticLow === 170, 'optimistic range low must be OHLCV confirmation')
assert(breakoutPlan?.optimisticHigh === 171, 'optimistic range high must be OHLCV resistance')
assert(breakoutPlan?.buyReferenceHigh === levels!.volumeNode, 'buy reference high must use the OHLCV volume node')

const watchPoint = formatOhlcvTradePlanWatchPoint(breakoutPlan!)

assert(watchPoint.startsWith('ohlcv_trade_plan:'), 'OHLCV backend plan should be persisted as a watch point')
assert(watchPoint.includes('buy_reference='), 'watch point should expose buy reference zone')
assert(watchPoint.includes('optimistic_range=170~171'), 'watch point should expose OHLCV optimistic range')
assert(!watchPoint.includes('fair_value'), 'watch point must not expose fair value as a trading line')
