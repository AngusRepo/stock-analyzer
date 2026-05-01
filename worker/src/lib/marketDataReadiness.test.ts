import { evaluateMarketDataReadiness } from './marketDataReadiness'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-29',
    priceRowsOnLatest: 2283,
    chipLatestDate: '2026-04-27',
    chipRowsOnLatest: 5100,
  })
  assert(!result.ok, 'stale price/chip dates must block EOD pipeline')
  assert(result.summary.includes('price latest=2026-04-29 expected=2026-04-30'), 'price date mismatch must be explicit')
  assert(result.summary.includes('chip latest=2026-04-27 expected=2026-04-30'), 'chip date mismatch must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 32,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
  })
  assert(!result.ok, 'too few price rows must block pipeline even when date matches')
  assert(result.summary.includes('price rows=32/1000'), 'price row-count floor must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 1082,
    priceTwseRowsOnLatest: 1068,
    priceOtcRowsOnLatest: 14,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
  })
  assert(!result.ok, 'partial OTC price rows must block pipeline even when total price rows pass')
  assert(result.summary.includes('OTC price rows=14/700'), 'OTC row-count floor must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 2283,
    priceTwseRowsOnLatest: 1085,
    priceOtcRowsOnLatest: 1198,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
  })
  assert(result.ok, 'fresh full-market price/chip data should pass')
}
