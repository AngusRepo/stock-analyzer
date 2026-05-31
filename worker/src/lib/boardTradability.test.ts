import {
  classifyBoard,
  isEmergingStylePriceRow,
  normalizeBoardType,
  recommendationLaneForBoard,
  resolveRecommendationGovernance,
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
  const classified = classifyBoard({ symbol: '0050', market: 'TWSE', open: 190, avg_price: null })
  assert(classified.boardType === 'ETF', 'ETF-like symbol must override TWSE metadata')
  assert(classified.recommendationLane === 'research_only', 'ETF must not enter tradable screener lane')
  assert(classified.eligibleForMl === false, 'ETF must not consume L1/L2 ML capacity')
  assert(classified.eligibleForPendingBuy === false, 'ETF must not become pending buy')

  const governed = resolveRecommendationGovernance(classified, {
    recommendationLane: 'tradable',
    eligibleForMl: 1,
    eligibleForPendingBuy: 1,
  })
  assert(governed.recommendationLane === 'research_only', 'ETF hard gate must override stale persisted tradable lane')
  assert(governed.eligibleForMl === false, 'ETF hard gate must override stale persisted ML eligibility')
  assert(governed.eligibleForPendingBuy === false, 'ETF hard gate must override stale persisted pending-buy eligibility')
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

{
  assert(normalizeBoardType('sii') === 'LISTED', 'FinLab sii should map to listed board')
  assert(normalizeBoardType('otc') === 'OTC', 'FinLab otc should map to OTC board')
  assert(normalizeBoardType('rotc') === 'EMERGING', 'FinLab rotc should map to emerging board')
  assert(normalizeBoardType('etf') === 'ETF', 'FinLab ETF market should map to ETF board')
  assert(normalizeBoardType('pub') === 'UNKNOWN', 'FinLab pub should not become tradable by default')
}
