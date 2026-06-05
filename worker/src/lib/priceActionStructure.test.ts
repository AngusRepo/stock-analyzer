import {
  buildPriceActionStructure,
  detectSmcStructure,
  detectBullishFairValueGaps,
  detectBullishOrderBlocks,
  formatPriceActionStructureWatchPoint,
} from './priceActionStructure'
import type { OhlcvRow } from './ohlcvTradePlanLevels'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const rows: OhlcvRow[] = [
  { date: '2026-06-01', open: 99, high: 100, low: 98, close: 99.5, volume: 1000 },
  { date: '2026-06-02', open: 99.5, high: 104, low: 98.5, close: 103.5, volume: 6000 },
  { date: '2026-06-03', open: 103.5, high: 105, low: 101, close: 104, volume: 3500 },
  { date: '2026-06-04', open: 104, high: 104.5, low: 100.5, close: 102.5, volume: 2800 },
]

{
  const gaps = detectBullishFairValueGaps(rows)
  assert(gaps.length === 1, 'three-candle bullish FVG should be detected')
  assert(gaps[0].low === 100, 'FVG low should anchor to the high two bars back')
  assert(gaps[0].high === 101, 'FVG high should anchor to the current candle low')
  assert(gaps[0].status === 'retested', 'FVG should be marked retested when price trades back into the gap')
}

const orderBlockRows: OhlcvRow[] = [
  { date: '2026-06-01', open: 99, high: 100, low: 98, close: 99, volume: 900 },
  { date: '2026-06-02', open: 99, high: 101, low: 98.8, close: 100, volume: 1200 },
  { date: '2026-06-03', open: 100, high: 101, low: 97, close: 98, volume: 1400 },
  { date: '2026-06-04', open: 98, high: 105, low: 97.8, close: 104, volume: 6500 },
  { date: '2026-06-05', open: 104, high: 106, low: 99.5, close: 103, volume: 4200 },
]

{
  const orderBlocks = detectBullishOrderBlocks(orderBlockRows, { breakLookback: 3 })
  assert(orderBlocks.length === 1, 'bullish BOS should identify the last bearish order block')
  assert(orderBlocks[0].low === 97, 'order block low should include the bearish candle wick')
  assert(orderBlocks[0].high === 100, 'order block high should use the bearish candle body top')
  assert(orderBlocks[0].status === 'retested', 'order block should be marked retested when price revisits the zone')
}

{
  const fvgStructure = buildPriceActionStructure(rows, { latestPrice: 103 })
  assert(fvgStructure.version === 'price_action_structure_v1', 'structure should expose a stable version')
  assert(fvgStructure.bestFvg != null, 'structure should expose the best live FVG')
  const obStructure = buildPriceActionStructure(orderBlockRows, { breakLookback: 3, latestPrice: 103 })
  assert(obStructure.bestOrderBlock != null, 'structure should expose the best live order block')
  const watchPoint = formatPriceActionStructureWatchPoint(obStructure)
  assert(watchPoint.includes('price_action_structure_v1'), 'watch point should identify the model')
  assert(watchPoint.includes('order_block='), 'watch point should expose order block zone')
  assert(watchPoint.includes('fvg='), 'watch point should expose FVG zone placeholder')
}

const smcRows: OhlcvRow[] = [
  { date: '2026-06-01', open: 100, high: 101, low: 98, close: 99, volume: 1000 },
  { date: '2026-06-02', open: 99, high: 100, low: 97.5, close: 98.5, volume: 1000 },
  { date: '2026-06-03', open: 98.5, high: 99, low: 96.8, close: 97.8, volume: 1100 },
  { date: '2026-06-04', open: 97.8, high: 98.2, low: 96.2, close: 96.8, volume: 1200 },
  { date: '2026-06-05', open: 96.8, high: 97.2, low: 95.8, close: 96.2, volume: 1300 },
  { date: '2026-06-08', open: 96.2, high: 97, low: 95.2, close: 96.8, volume: 1800 },
  { date: '2026-06-09', open: 96.8, high: 102.8, low: 96.7, close: 102.2, volume: 5000 },
  { date: '2026-06-10', open: 102.2, high: 104.5, low: 101.5, close: 104, volume: 5200 },
]

{
  const smc = detectSmcStructure(smcRows, { structureLookback: 5 })
  assert(smc.bias === 'bullish', 'bullish liquidity sweep plus structure break should produce bullish SMC bias')
  assert(smc.bullishLiquiditySweep != null, 'SMC should detect bullish liquidity sweep')
  assert(smc.bullishBos != null || smc.bullishChoch != null, 'SMC should detect bullish BOS or CHOCH')
  assert(smc.bullishScore > smc.bearishScore, 'bullish SMC score should dominate bearish score')
}
