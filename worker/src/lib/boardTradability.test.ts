import {
  classifyBoard,
  isEmergingStylePriceRow,
  recommendationLaneForBoard,
} from './boardTradability'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const classified = classifyBoard({ market: 'OTC', open: null, avg_price: 100.53 })
  assert(classified.boardType === 'EMERGING', 'latest avg-price-only row must override stale OTC market metadata')
  assert(classified.tradabilityTier === 'research_only', 'emerging row should be research-only')
  assert(classified.eligibleForPendingBuy === false, 'emerging row must never be pending-buy eligible')
}

{
  const classified = classifyBoard({ market: 'TWSE', open: 266, avg_price: null })
  assert(classified.boardType === 'LISTED', 'TWSE row should be listed')
  assert(classified.tradabilityTier === 'auto_tradable', 'listed row should be auto-tradable unless restricted')
  assert(classified.eligibleForPendingBuy === true, 'listed row should be pending-buy eligible unless restricted')
}

{
  const classified = classifyBoard({ market: 'TWSE', open: 266, avg_price: null, restricted: true })
  assert(classified.tradabilityTier === 'blocked', 'restricted stocks should be blocked')
  assert(classified.eligibleForMl === false, 'restricted stocks should not consume ML shortlist capacity')
  assert(classified.eligibleForPendingBuy === false, 'restricted stocks must not become pending buys')
}

{
  assert(isEmergingStylePriceRow({ open: null, avg_price: 100.53 }), 'avg-price only rows are emerging-style')
  assert(!isEmergingStylePriceRow({ open: 52.4, avg_price: null }), 'regular OHLC rows are not emerging-style')
  assert(recommendationLaneForBoard('EMERGING') === 'emerging_watchlist', 'emerging board should route to watchlist lane')
  assert(recommendationLaneForBoard('OTC') === 'tradable', 'OTC board should route to tradable lane')
}
