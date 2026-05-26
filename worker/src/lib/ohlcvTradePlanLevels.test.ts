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

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
