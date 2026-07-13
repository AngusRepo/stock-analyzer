import { resolvePositionExitSellFill } from './paperExitTasks'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const oddLotExit = resolvePositionExitSellFill(331, {
  oddLot: {
    last: 139.5,
    bid: 139,
    ask: 139.5,
    low: 138.5,
    high: 143,
    lotType: 'odd_lot',
    source: 'shioaji',
  },
})
assert(oddLotExit.fillable, '331-share position must be executable against a dedicated odd-lot book')
assert(oddLotExit.price === 138.5, 'odd-lot sell must conservatively slip from the odd-lot best bid')
assert(oddLotExit.reason === 'odd_lot_sell_fill', 'odd-lot execution reason must preserve lot provenance')

const wrongBook = resolvePositionExitSellFill(331, {
  boardLot: {
    last: 139.5,
    bid: 139,
    ask: 139.5,
    lotType: 'board_lot',
    source: 'shioaji',
  },
})
assert(!wrongBook.fillable, 'board-lot book must not execute an odd-lot position')
assert(wrongBook.reason === 'tw_equity_odd_lot_book_required', 'missing dedicated odd-lot book must be explicit')

const splitExit = resolvePositionExitSellFill(1331, {
  boardLot: {
    last: 140,
    bid: 139.5,
    ask: 140,
    lotType: 'board_lot',
    source: 'shioaji',
  },
  oddLot: {
    last: 139.5,
    bid: 139,
    ask: 139.5,
    lotType: 'odd_lot',
    source: 'shioaji',
  },
})
assert(splitExit.fillable, 'mixed position must split across board-lot and odd-lot books')
assert(splitExit.reason === 'tw_equity_split_lot_sell_fill', 'split-lot execution must be auditable')

console.log('paperExitTasks odd-lot execution tests passed')
