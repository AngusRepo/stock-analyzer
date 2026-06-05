import { buildEntryPriceModelV2FromOhlcvPlan, buildVolumeProfileV2 } from './entryPriceModelV2'
import { replayEntryModelCase, summarizeEntryModelReplay } from './entryModelReplay'
import { buildPriceActionStructure } from './priceActionStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const plan = {
  source: 'ohlcv' as const,
  mode: 'pullback' as const,
  entryPrice: 98,
  stopLoss: 94,
  target1: 103,
  target2: 108,
  latestClose: 99,
  resistance: 102,
  confirmation: 103,
  support: 95,
  atrDefense: 94,
  volumeNode: 97,
  buyReferenceLow: 96,
  buyReferenceHigh: 98,
  optimisticLow: 103,
  optimisticHigh: 105,
}

{
  const model = buildEntryPriceModelV2FromOhlcvPlan(plan)
  assert(model.modelVersion === 'entry_price_model_v2', 'model should expose explicit v2 version')
  assert(model.anchorSource === 'daily_proxy_fallback', 'OHLCV-only model must identify daily proxy fallback')
  assert(model.entryLow <= model.preferredEntry && model.preferredEntry <= model.entryHigh, 'preferred entry should stay inside the entry band')
  assert(model.chaseCeiling === 105, 'old optimistic high should become the v2 chase ceiling fallback')
  assert(model.fallbackReason === 'ohlcv_trade_plan_proxy', 'daily proxy fallback should be explicit')
}

{
  const profile = buildVolumeProfileV2([
    { date: '2026-06-01', time: '090000', open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
    { date: '2026-06-01', time: '090100', open: 100.5, high: 103, low: 100, close: 102.5, volume: 6000 },
    { date: '2026-06-01', time: '090200', open: 102.5, high: 104, low: 102, close: 103, volume: 2000 },
  ])
  assert(profile.poc != null, 'intraday bars should produce a profile POC')
  assert(profile.vah != null && profile.val != null && profile.vah >= profile.val, 'profile should produce VAH/VAL')
}

{
  const profile = buildVolumeProfileV2([
    { date: '2026-06-01', time: '090000', open: 97, high: 98, low: 96.5, close: 97.5, volume: 800 },
    { date: '2026-06-01', time: '090100', open: 97.5, high: 99, low: 97, close: 98.5, volume: 5000 },
    { date: '2026-06-01', time: '090200', open: 98.5, high: 100, low: 98, close: 99.2, volume: 2200 },
  ])
  const model = buildEntryPriceModelV2FromOhlcvPlan(plan, {
    anchorSource: 'intraday_volume_profile',
    profile,
  })
  assert(model.anchorSource === 'intraday_volume_profile', 'model should promote source when intraday volume profile is available')
  assert(model.poc === profile.poc, 'model POC should come from intraday profile')
  assert(model.vah === profile.vah && model.val === profile.val, 'model should expose intraday VAH/VAL')
  assert(model.fallbackReason == null, 'intraday profile model should not be labeled as daily fallback')
}

{
  const oldModel = { entryPrice: 106, optimisticHigh: 106, stopLoss: 96 }
  const newModel = buildEntryPriceModelV2FromOhlcvPlan(plan)
  const result = replayEntryModelCase({
    runDate: '2026-06-01',
    symbol: '2887',
    oldModel,
    newModel,
    pricePath: {
      open: 100,
      high: 104,
      low: 97,
      close: 103,
      next5Close: 106,
    },
  })
  assert(result.oldDecision.wouldBuy === false, 'old single-point entry can miss a valid pullback fill')
  assert(result.newDecision.wouldBuy === true, 'v2 entry band should fill when price trades inside the band')
  const summary = summarizeEntryModelReplay([result])
  assert(summary.newFillRate > summary.oldFillRate, 'summary should expose the v2 fill-rate improvement')
}

{
  const priceActionStructure = buildPriceActionStructure([
    { date: '2026-06-01', open: 99, high: 100, low: 98, close: 99.5, volume: 1000 },
    { date: '2026-06-02', open: 99.5, high: 104, low: 98.5, close: 103.5, volume: 6000 },
    { date: '2026-06-03', open: 103.5, high: 105, low: 101, close: 104, volume: 3500 },
    { date: '2026-06-04', open: 104, high: 104.5, low: 100.5, close: 102.5, volume: 2800 },
  ], { breakLookback: 3, latestPrice: 103 })
  const model = buildEntryPriceModelV2FromOhlcvPlan(plan, { priceActionStructure })
  assert(model.fvgLow === 100 && model.fvgHigh === 101, 'entry model should expose observed FVG zone')
  assert(model.retestStatus === 'confirmed', 'retested FVG should become confirmed structure evidence')
  assert(model.anchorSource === 'daily_proxy_fallback', 'price action observe must not pretend to be a true volume profile source')
  assert(model.confidence > 0.45, 'confirmed structure can lift confidence without changing the anchor source')
}
