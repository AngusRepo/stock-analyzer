import {
  buildAtrBandSeries,
  buildTradingPlanLevels,
  normalizeOhlcvRows,
  volumeNode,
} from './tradingPlanLevels'

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

{
  const levels = buildTradingPlanLevels(rows)
  assert(levels != null, 'trading plan levels should be computed from OHLCV rows')
  assert(levels!.latestClose === 169, 'latest close should be deterministic')
  assert(levels!.support === 107, 'support should be the swing low in the lookback window')
  assert(levels!.resistance === 171, 'resistance should be the swing high in the lookback window')
  assert(levels!.atrLower != null && levels!.atrLower < levels!.latestClose, 'ATR lower band should sit below latest close')
  assert(levels!.atrUpper != null && levels!.atrUpper > levels!.latestClose, 'ATR upper band should sit above latest close')
  assert(levels!.ma20 === 159.5, 'MA20 should be derived from the same close series')
  assert(levels!.ma60 === 139.5, 'MA60 should be derived from the same close series')
}

{
  const bands = buildAtrBandSeries(rows)
  assert(bands.length === rows.length - 14, 'ATR band should start after enough history exists')
  assert(bands[bands.length - 1].lower < rows[rows.length - 1].close, 'latest ATR lower band should be below close')
  assert(bands[bands.length - 1].upper > rows[rows.length - 1].close, 'latest ATR upper band should be above close')
}

{
  const node = volumeNode(rows.slice(-30))
  assert(node != null && node > 140 && node < 170, 'volume node should follow the high-volume price region')
}
