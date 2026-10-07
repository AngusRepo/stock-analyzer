import { applyPartialFill, calcCommission, isLimitDownLocked, resolveLimitBuyFill, resolveLimitSellFill, resolveMarketSellFill } from './paperTradeMath'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
import { isValidTwTickPrice } from './twMarketRules'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const cfg = DEFAULT_TRADING_CONFIG
  assert(calcCommission(122 * 31, cfg, 31) === 5, '3004 gross commission is NT$5 before monthly rebates')
  assert(calcCommission(122, cfg, 1) === 1, 'one-share order uses the NT$1 odd-lot minimum')
  assert(calcCommission(10_000, cfg, 999) === 14, 'odd lots are not charged a fixed NT$1')
  assert(calcCommission(10_000, cfg, 1000) === 20, 'board-lot minimum remains configured NT$20')
  assert(calcCommission(20_000, cfg, 1000) === 28, 'gross commission truncates fractional dollars')
  assert(calcCommission(10_010, cfg, 1001) === 21, 'mixed order charges board and odd legs separately')
  assert(calcCommission(122 * 1331, cfg, 1331) === 230, 'mixed order truncates each market leg separately')
  assert(calcCommission(620, cfg, 31) === 1, 'partial odd-lot fill uses actual filled shares')
  assert(calcCommission(2 / cfg.fees.commission - 1e-9, cfg, 31) === 1,
    'fractional commission just below two dollars must not round up')
  assert(calcCommission(122, {...cfg, fees:{...cfg.fees,commission:0,minCommission:0}}, 1) === 0,
    'explicit free-fee research fixture is preserved')
  for (const [value, shares] of [[3782,0],[3782,31.5],[3782,NaN],[-1,31],[NaN,31]]) {
    let rejected = false
    try { calcCommission(value, cfg, shares) } catch { rejected = true }
    assert(rejected, 'commission rejects invalid value/share inputs')
  }
}

{
  assert(!isLimitDownLocked(90.5, 100, 1_000, 100_000), '9.5% down is not the official Taiwan-equity limit-down price')
  assert(isLimitDownLocked(90, 100, 1_000, 100_000), 'official limit-down with a thin book should be treated as locked')
}

{
  const fill = resolveLimitBuyFill({
    currentPrice: 299,
    limitPrice: 300,
    bestAsk: null,
    intradayLow: 298,
    intradayHigh: 301,
    requireBestAsk: true,
  })
  assert(!fill.fillable, 'auto buy execution must fail closed when executable ask is missing')
  assert(fill.reason === 'missing_best_ask', 'missing buy-side quote should be explicit')
}

{
  const fill = resolveMarketSellFill({
    currentPrice: 305,
    bestBid: null,
    intradayLow: 304,
    intradayHigh: 306,
    requireBestBid: true,
  })
  assert(!fill.fillable, 'auto sell execution must fail closed when executable bid is missing')
  assert(fill.reason === 'missing_best_bid', 'missing sell-side quote should be explicit')
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
    bestAsk: 305,
    slippageTicks: 1,
  })
  assert(!fill.fillable, 'buy limit must not fill when current executable ask is above limit')
  assert(fill.reason.startsWith('ask_above_limit'), 'unfilled executable quote should explain ask > limit')
}

{
  const fill = resolveLimitBuyFill({
    currentPrice: 299,
    limitPrice: 299.5,
    bestAsk: 299.4,
    intradayLow: 298.5,
    intradayHigh: 300,
    slippageTicks: 1,
  })
  assert(fill.fillable, 'marketable buy limit should fill when current price is below limit')
  assert(fill.fillPrice === 299.5, 'slipped buy fill should be capped at limit price')
}

{
  const fill = resolveLimitBuyFill({
    currentPrice: 141.5,
    limitPrice: 141.6,
    bestAsk: 141.5,
    intradayLow: 141,
    intradayHigh: 144.5,
    slippageTicks: 1,
    requireBestAsk: true,
  })
  assert(fill.fillable, 'buy should fill when legal best ask is within normalized limit')
  assert(fill.fillPrice === 141.5, 'illegal 141.6 buy limit should be normalized to 141.5')
  assert(isValidTwTickPrice(fill.fillPrice), 'buy fill price must be a legal TW tick')
}

{
  const filledShares = applyPartialFill(10_000, 100, 50_000, {
    position: {
      partialFillThreshold: 0.05,
      partialFillRate: 0.5,
    },
  } as any)
  assert(filledShares < 10_000, 'oversized paper order should be partially filled against available volume')
  assert(filledShares > 0, 'partial fill must keep a positive fill size')
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

{
  const fill = resolveLimitSellFill({
    currentPrice: 305,
    limitPrice: 305,
    bestBid: 304,
    slippageTicks: 1,
  })
  assert(!fill.fillable, 'sell limit must not fill when executable bid is below limit')
  assert(fill.reason.startsWith('bid_below_limit'), 'unfilled sell quote should explain bid < limit')
}

{
  const fill = resolveLimitSellFill({
    currentPrice: 305,
    limitPrice: 304,
    bestBid: 304.5,
    intradayLow: 303,
    intradayHigh: 306,
    slippageTicks: 1,
  })
  assert(fill.fillable, 'marketable sell limit should fill when executable bid is above limit')
  assert(fill.fillPrice === 304, 'slipped sell fill should be floored at limit price')
}

{
  const fill = resolveLimitSellFill({
    currentPrice: 305,
    limitPrice: 305,
    intradayLow: 304,
    intradayHigh: 304.5,
    slippageTicks: 1,
  })
  assert(!fill.fillable, 'sell limit must not fill when intraday high stays below limit')
  assert(fill.reason.startsWith('limit_not_touched'), 'unfilled sell should explain high < limit')
}

{
  const fill = resolveLimitSellFill({
    currentPrice: 141.5,
    limitPrice: 141.6,
    bestBid: 142,
    intradayLow: 141,
    intradayHigh: 144.5,
    slippageTicks: 1,
    requireBestBid: true,
  })
  assert(fill.fillable, 'sell should fill when legal bid is above normalized minimum')
  assert(fill.fillPrice === 142, 'illegal 141.6 sell limit should be normalized to 142')
  assert(isValidTwTickPrice(fill.fillPrice), 'sell fill price must be a legal TW tick')
}

{
  const fill = resolveMarketSellFill({
    currentPrice: 305,
    bestBid: 304,
    intradayLow: 303,
    intradayHigh: 306,
    slippageTicks: 1,
  })
  assert(fill.fillable, 'market sell should execute against broker bid when bid is available')
  assert(fill.fillPrice === 303.5, 'market sell should apply conservative slippage from best bid')
}

{
  const fill = resolveMarketSellFill({
    currentPrice: 305,
    bestBid: null,
    intradayLow: 305,
    intradayHigh: 305,
    slippageTicks: 1,
  })
  assert(!fill.fillable, 'market sell should fail closed when executable bid is missing')
  assert(fill.reason === 'missing_best_bid', 'missing bid must not fall back to last/current price')
}

{
  const fill = resolveMarketSellFill({
    currentPrice: 29,
    bestBid: null,
    intradayLow: 28.8,
    intradayHigh: 29.2,
    slippageTicks: 1,
    requireBestBid: false,
  })
  assert(fill.fillable, 'TP1 partial sell may use last-price fallback when broker bid is missing')
  assert(fill.reason === 'last_price_fallback_market_sell', 'last-price fallback must be explicit')
  assert(fill.fillPrice != null && fill.fillPrice < 29, 'fallback sell should still apply conservative slippage')
}
