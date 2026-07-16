import { mergePendingExitAttemptDetail, resolvePositionExitSellFill } from './paperExitTasks'

const quoteTime = new Date().toISOString()

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
    quoteTime,
    bidPrices: [139, 138.5],
    askPrices: [139.5],
    bidVolumes: [331, 1000],
    askVolumes: [500],
    volumeUnit: 'shares',
  },
})
assert(oddLotExit.fillable, '331-share position must be executable against a dedicated odd-lot book')
assert(oddLotExit.price === 139, 'odd-lot sell must consume the visible odd-lot bid')
assert(oddLotExit.reason === 'odd_lot_sell_fill', 'odd-lot execution reason must preserve lot provenance')

const wrongBook = resolvePositionExitSellFill(331, {
  boardLot: {
    last: 139.5,
    bid: 139,
    ask: 139.5,
    lotType: 'board_lot',
    source: 'shioaji',
    quoteTime,
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
    quoteTime,
    bidPrices: [139.5],
    askPrices: [140],
    bidVolumes: [1],
    askVolumes: [1],
    volumeUnit: 'lots',
  },
  oddLot: {
    last: 139.5,
    bid: 139,
    ask: 139.5,
    lotType: 'odd_lot',
    source: 'shioaji',
    quoteTime,
    bidPrices: [139],
    askPrices: [139.5],
    bidVolumes: [331],
    askVolumes: [500],
    volumeUnit: 'shares',
  },
})
assert(splitExit.fillable, 'mixed position must split across board-lot and odd-lot books')
assert(splitExit.reason === 'tw_equity_split_lot_sell_fill', 'split-lot execution must be auditable')

const depthLimitedExit = resolvePositionExitSellFill(500, {
  oddLot: {
    last: 139.5,
    bid: 139,
    ask: 139.5,
    lotType: 'odd_lot',
    source: 'shioaji',
    quoteTime,
    bidPrices: [139],
    askPrices: [139.5],
    bidVolumes: [200],
    askVolumes: [500],
    volumeUnit: 'shares',
  },
})
assert(depthLimitedExit.fillable, 'visible odd-lot depth must allow a partial exit')
assert(depthLimitedExit.filledShares === 200, 'partial exit must not fill more shares than visible depth')
assert(depthLimitedExit.complete === false, 'depth-limited exit must remain incomplete for retry')
assert(depthLimitedExit.reason === 'tw_equity_visible_depth_partial_exit', 'partial exit reason must preserve depth evidence')

const staleConfirmationTime = new Date(Date.now() - 5_000).toISOString()
const staleBook = resolvePositionExitSellFill(1000, {
  boardLot: {
    last: 71.7,
    bid: 71.7,
    ask: 71.8,
    lotType: 'board_lot',
    source: 'shioaji',
    quoteTime: staleConfirmationTime,
    confirmationTime: staleConfirmationTime,
    bidPrices: [71.7],
    askPrices: [71.8],
    bidVolumes: [2],
    askVolumes: [2],
    volumeUnit: 'lots',
  },
}, { maxAgeMs: 1500 })
assert(!staleBook.fillable, 'execution matcher must fail closed on a stale refreshed book')
assert(staleBook.reason.includes('execution_book_stale_or_incomplete'), 'stale execution reason must remain diagnostic')

const firstAttempt = mergePendingExitAttemptDetail(null, {
  reason: staleBook.reason,
  attemptedAt: '2026-07-16T05:17:08.000Z',
  detail: { exit_intent_key: '1:4541:2026-07-13:2000:72.8000:full_sell' },
})
const secondAttempt = mergePendingExitAttemptDetail(firstAttempt, {
  reason: 'authoritative_depth_missing',
  attemptedAt: '2026-07-16T05:18:08.000Z',
  detail: { snapshot_id: 'aes-retry' },
})
assert(secondAttempt.attempt_count === 2, 'same exit intent must accumulate retry attempts')
assert(secondAttempt.first_attempted_at === '2026-07-16T05:17:08.000Z', 'retry must preserve the first attempt time')
assert(secondAttempt.last_attempted_at === '2026-07-16T05:18:08.000Z', 'retry must expose the latest attempt time')
assert(Array.isArray(secondAttempt.attempt_history) && secondAttempt.attempt_history.length === 2, 'retry history must preserve execution evidence')

console.log('paperExitTasks odd-lot execution tests passed')
