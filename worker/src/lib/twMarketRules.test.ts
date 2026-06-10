import {
  buildTwOrderLegs,
  isValidTwTickPrice,
  normalizeTwFilledSharesForRequestedOrder,
  normalizeTwLimitPrice,
  snapToTwPriceTick,
} from './twMarketRules'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(snapToTwPriceTick(141.6, 'floor') === 141.5, '100-500 buy price should floor to 0.5 tick')
  assert(snapToTwPriceTick(141.6, 'ceil') === 142, '100-500 sell/chase price should ceil to 0.5 tick')
  assert(isValidTwTickPrice(141.5), '141.5 should be a valid TW tick price')
  assert(!isValidTwTickPrice(141.6), '141.6 should not be a valid TW tick price')
  assert(normalizeTwLimitPrice(141.6, 'buy') === 141.5, 'buy limit should not exceed raw max price')
  assert(normalizeTwLimitPrice(141.6, 'sell') === 142, 'sell limit should not fall below raw minimum price')
}

{
  const legs = buildTwOrderLegs(3209)
  assert(legs.length === 2, 'mixed quantity should split into board and odd lot legs')
  assert(legs[0]?.lotType === 'board_lot' && legs[0].shares === 3000, 'board leg should carry full lots')
  assert(legs[0]?.finlabQuantity === 3 && legs[0].finlabQuantityUnit === 'lots', 'board leg should map to FinLab lots')
  assert(legs[1]?.lotType === 'odd_lot' && legs[1].shares === 209, 'odd leg should carry remainder shares')
  assert(legs[1]?.finlabQuantity === 209 && legs[1].oddLot === true, 'odd leg should map to FinLab odd-lot shares')
}

{
  assert(
    normalizeTwFilledSharesForRequestedOrder(4000, 3209) === 3000,
    'board-only partial fill should preserve 1000-share execution quantum',
  )
  assert(
    normalizeTwFilledSharesForRequestedOrder(498, 402) === 402,
    'odd-only partial fill should allow 1-999 shares',
  )
  assert(
    normalizeTwFilledSharesForRequestedOrder(3209, 3100) === 3100,
    'mixed order partial fill should allow board fill plus odd-lot fill',
  )
}
