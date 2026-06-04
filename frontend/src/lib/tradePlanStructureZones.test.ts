import { buildTradePlanStructureZones } from './tradePlanStructureZones.ts'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const alphaContext = {
  latestClose: 66,
  poc: 52,
  fairValueLow: 50,
  fairValueHigh: 55,
  optimisticValueHigh: 80,
}

{
  const zones = buildTradePlanStructureZones({
    source: 'ohlcv',
    latest: 66,
    support: 58.4,
    volumeNode: 61.2,
    confirmation: 65.4,
    resistance: 69,
    atrDefense: 57.8,
  }, alphaContext)

  assert(zones.source === 'ohlcv', 'OHLCV plan should be the primary source when available')
  assert(zones.buyReferenceZone === '58.40~61.20', 'buy reference zone must use OHLCV support and volume node')
  assert(zones.chaseCeilingZone === '65.40~69.00', 'chase ceiling zone must use OHLCV confirmation and resistance')
  assert(zones.breakoutChaseZone === '65.40~66.58', 'breakout chase zone should start from OHLCV confirmation')
  assert(!zones.chaseCeilingZone.includes('80.00'), 'OHLCV chase ceiling zone must not reuse alpha optimistic value high')
}

{
  const zones = buildTradePlanStructureZones({
    source: 'ohlcv',
    latest: 66,
    support: 58.4,
    volumeNode: 61.2,
    confirmation: 65.4,
    resistance: 65.4,
  }, alphaContext)

  assert(zones.chaseCeilingZone === '65.40~66.58', 'OHLCV chase ceiling zone must not sit below the breakout chase ceiling')
  assert(zones.breakoutChaseZone === '65.40~66.58', 'breakout chase zone should stay aligned with the optimistic buyable ceiling')
}

{
  const zones = buildTradePlanStructureZones(null, alphaContext)

  assert(zones.source === 'alpha_fallback', 'alpha values are allowed only as fallback when OHLCV is missing')
  assert(zones.buyReferenceZone === '50.00~52.00', 'fallback buy reference should use alpha fair low and POC')
  assert(zones.chaseCeilingZone === '55.00~80.00', 'fallback chase ceiling zone should be visibly alpha-derived')
  assert(zones.optimisticPriceRange === zones.chaseCeilingZone, 'legacy optimisticPriceRange alias should stay compatible')
}
