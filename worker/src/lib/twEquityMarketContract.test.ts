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

console.log('twEquityMarketContract tests passed')
