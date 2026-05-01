import { resolveLimitBuyFill } from './paperTradeMath'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const fill = resolveLimitBuyFill({
    currentPrice: 299.5,
    limitPrice: 299.5,
    intradayLow: 305,
    intradayHigh: 305,
    slippageTicks: 1,
  })
  assert(!fill.fillable, 'buy limit must not fill when intraday low stays above limit')
  assert(fill.reason.startsWith('limit_not_touched'), 'unfilled limit should explain low > limit')
}

{
  const fill = resolveLimitBuyFill({
    currentPrice: 305,
    limitPrice: 299.5,
    slippageTicks: 1,
  })
  assert(!fill.fillable, 'buy limit must not fill when current price is above limit and no low proves a touch')
}

{
  const fill = resolveLimitBuyFill({
    currentPrice: 299,
    limitPrice: 299.5,
    intradayLow: 298.5,
    intradayHigh: 300,
    slippageTicks: 1,
  })
  assert(fill.fillable, 'marketable buy limit should fill when current price is below limit')
  assert(fill.fillPrice === 299.5, 'slipped buy fill should be capped at limit price')
}

{
  const fill = resolveLimitBuyFill({
    currentPrice: 305,
    limitPrice: 305,
    intradayLow: 306,
    intradayHigh: 305,
    slippageTicks: 1,
  })
  assert(!fill.fillable, 'invalid intraday high/low must fail closed')
  assert(fill.reason.startsWith('invalid_intraday_range'), 'invalid range should be explicit')
}
