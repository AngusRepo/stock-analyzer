import {
  normalizeTwEquityStopPrice,
  normalizeTwEquityTargetPrice,
  resolveTwEquityExecutionGate,
  resolveTwEquityPriceBand,
  resolveTwEquitySessionPhase,
} from './twEquityMarketContract'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const band = resolveTwEquityPriceBand(143.5)
assert(band.limitUp === 157.5, 'limit-up must use the official 10% reference band and legal TW tick')
assert(band.limitDown === 129.5, 'limit-down must use the official 10% reference band and legal TW tick')
assert(normalizeTwEquityStopPrice(143.32, band) === 143, 'protective stops must snap down to a legal TW tick')
assert(normalizeTwEquityTargetPrice(163.11, band) === 157.5, 'targets must snap up and remain inside the official price band')

assert(resolveTwEquitySessionPhase(new Date('2026-07-11T02:00:00.000Z')) === 'closed', 'Saturday must be closed')
assert(resolveTwEquitySessionPhase(new Date('2026-07-10T01:10:00.000Z')) === 'odd_lot_first_match', '09:10 TW must expose the odd-lot first match')
assert(resolveTwEquitySessionPhase(new Date('2026-07-10T05:32:00.000Z'), { delayedClose: true }) === 'delayed_close', 'delayed close may extend to 13:33')

const wrongBook = resolveTwEquityExecutionGate({
  now: new Date('2026-07-10T02:00:00.000Z'),
  lotType: 'odd_lot',
  marketDataLotType: 'board_lot',
})
assert(!wrongBook.allowed && wrongBook.reason === 'tw_equity_odd_lot_book_required', 'odd-lot execution must not reuse the board-lot L5 book')

const beforeOddLotMatch = resolveTwEquityExecutionGate({
  now: new Date('2026-07-10T01:05:00.000Z'),
  lotType: 'odd_lot',
  marketDataLotType: 'odd_lot',
})
assert(!beforeOddLotMatch.allowed && beforeOddLotMatch.reason === 'tw_equity_odd_lot_waiting_first_match', 'odd-lot orders must not fake fills before the 09:10 first match')

const suspended = resolveTwEquityExecutionGate({
  now: new Date('2026-07-10T02:00:00.000Z'),
  lotType: 'board_lot',
  marketDataLotType: 'board_lot',
  status: { suspended: true },
})
assert(!suspended.allowed, 'suspended stock must fail closed')

{
  // Exhaustive limit band check against an exact integer-cent reference for every legal
  // previous close 0.01..6000: limit-up = largest legal tick <= prev * 1.1,
  // limit-down = smallest legal tick >= prev * 0.9 (tick decided by the result's own band).
  const legalCents: number[] = []
  const addGrid = (from: number, to: number, step: number) => {
    for (let cents = from; cents <= to; cents += step) legalCents.push(cents)
  }
  addGrid(1, 999, 1)
  addGrid(1000, 4995, 5)
  addGrid(5000, 9990, 10)
  addGrid(10000, 49950, 50)
  addGrid(50000, 99900, 100)
  addGrid(100000, 700000, 500)
  const largestAtMost = (numerator: number, denominator: number): number => {
    let found = 0
    for (let lo = 0, hi = legalCents.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1
      if (legalCents[mid] * denominator <= numerator) {
        found = legalCents[mid]
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }
  const smallestAtLeast = (numerator: number, denominator: number): number => {
    let found = 0
    for (let lo = 0, hi = legalCents.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1
      if (legalCents[mid] * denominator >= numerator) {
        found = legalCents[mid]
        hi = mid - 1
      } else lo = mid + 1
    }
    return found
  }
  let checked = 0
  for (const prevCents of legalCents) {
    if (prevCents > 600000) break
    const prev = prevCents / 100
    const priceBand = resolveTwEquityPriceBand(prev)
    const expectedUp = largestAtMost(prevCents * 11, 10) / 100
    const expectedDown = smallestAtLeast(prevCents * 9, 10) / 100
    assert(priceBand.limitUp === expectedUp, `prev ${prev}: limit-up ${priceBand.limitUp} should be ${expectedUp}`)
    assert(priceBand.limitDown === expectedDown, `prev ${prev}: limit-down ${priceBand.limitDown} should be ${expectedDown}`)
    checked += 1
  }
  assert(checked === 4600, 'every legal previous close 0.01..6000 should be checked')

  const band906 = resolveTwEquityPriceBand(9.06)
  assert(band906.limitUp === 9.96 && band906.limitDown === 8.16, 'prev 9.06 band should be 8.16..9.96')
  const band1995 = resolveTwEquityPriceBand(19.95)
  assert(band1995.limitUp === 21.9 && band1995.limitDown === 18, 'prev 19.95 band should be 18.00..21.90')
}

console.log('twEquityMarketContract tests passed')
