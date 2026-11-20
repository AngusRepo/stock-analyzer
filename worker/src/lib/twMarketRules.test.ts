import {
  buildTwOrderLegs,
  getTwTickSize,
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
  // Exact integer-cent TW tick grid 0.01..6000 as the reference implementation.
  const validCents: number[] = []
  const addGrid = (from: number, to: number, step: number) => {
    for (let cents = from; cents <= to; cents += step) validCents.push(cents)
  }
  addGrid(1, 999, 1)
  addGrid(1000, 4995, 5)
  addGrid(5000, 9990, 10)
  addGrid(10000, 49950, 50)
  addGrid(50000, 99900, 100)
  addGrid(100000, 600000, 500)
  assert(validCents.length === 4600, 'reference grid should hold every legal 0.01..6000 tick price')
  for (const cents of validCents) {
    const price = cents / 100
    for (const mode of ['floor', 'ceil', 'nearest'] as const) {
      assert(snapToTwPriceTick(price, mode) === price, `legal tick ${price} must snap to itself (${mode})`)
    }
  }
}

{
  // Sub-tick remainders must not be rounded to cents before ceil/floor.
  assert(snapToTwPriceTick(9.06 * 0.9, 'ceil') === 8.16, 'ceil(8.154) must not lose a tick')
  assert(snapToTwPriceTick(9.06 * 1.1, 'floor') === 9.96, 'floor(9.966) must not gain a tick')
  assert(snapToTwPriceTick(19.95 * 0.9, 'ceil') === 18, 'ceil(17.955) must reach 18.00 on the 0.05 tick')
  assert(snapToTwPriceTick(19.95 * 1.1, 'floor') === 21.9, 'floor(21.945) must stay at 21.90 on the 0.05 tick')
  // Ceil across a tick-band boundary lands on the boundary, which is legal in the upper band.
  assert(snapToTwPriceTick(9.995, 'ceil') === 10, 'ceil(9.995) should reach 10.00')
  assert(snapToTwPriceTick(49.96, 'ceil') === 50, 'ceil(49.96) should reach 50.00')
  assert(snapToTwPriceTick(99.95, 'ceil') === 100, 'ceil(99.95) should reach 100')
  assert(snapToTwPriceTick(499.7, 'ceil') === 500, 'ceil(499.7) should reach 500')
  assert(snapToTwPriceTick(999.5, 'ceil') === 1000, 'ceil(999.5) should reach 1000')
  assert(snapToTwPriceTick(10.04, 'floor') === 10, 'floor(10.04) should use the 0.05 tick')
}

{
  // Validity uses the snap's tick-unit tolerance: 1e-7 below 8.16 is a real remainder, not float noise.
  assert(!isValidTwTickPrice(8.1599999), '8.1599999 is not a legal tick price')
  assert(normalizeTwLimitPrice(8.1599999, 'buy') === 8.15, 'buy limit of 8.1599999 must floor to 8.15')
  assert(normalizeTwLimitPrice(8.1599999, 'sell') === 8.16, 'sell limit of 8.1599999 must ceil to 8.16')
  assert(isValidTwTickPrice(0.1 + 0.2), 'float noise around a legal tick stays valid')
  assert(!isValidTwTickPrice(1e-9), 'a price that snaps to zero is never a legal tick')

  // Exhaustive consistency over every legal 0.01..6000 tick price and small perturbations:
  // valid <=> floor and ceil agree, and then all three modes return the same legal price.
  const legalCents: number[] = []
  const addGrid = (from: number, to: number, step: number) => {
    for (let cents = from; cents <= to; cents += step) legalCents.push(cents)
  }
  addGrid(1, 999, 1)
  addGrid(1000, 4995, 5)
  addGrid(5000, 9990, 10)
  addGrid(10000, 49950, 50)
  addGrid(50000, 99900, 100)
  addGrid(100000, 600000, 500)
  const offsets = [1e-12, 1e-10, 1e-9, 1e-8, 5e-8, 1e-7, 5e-7, 1e-6, 5e-6, 1e-5, 1e-3]
  for (const cents of legalCents) {
    const price = cents / 100
    const inputs = [price, price * (1 + Number.EPSILON), price * (1 - Number.EPSILON)]
    for (const offset of offsets) inputs.push(price + offset, price - offset)
    for (const input of inputs) {
      const floor = snapToTwPriceTick(input, 'floor')
      const ceil = snapToTwPriceTick(input, 'ceil')
      const nearest = snapToTwPriceTick(input, 'nearest')
      assert((floor === 0 || isValidTwTickPrice(floor)) && isValidTwTickPrice(ceil), `snaps of ${input} must be legal ticks`)
      if (isValidTwTickPrice(input)) {
        assert(floor === ceil && ceil === nearest, `valid ${input} must snap to one price in every mode`)
        assert(Math.abs(floor - input) <= 1.0001e-6 * getTwTickSize(input), `valid ${input} must snap within the tolerance`)
      } else {
        assert(floor < ceil, `invalid ${input} must lie strictly between two legal ticks`)
      }
    }
  }
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
