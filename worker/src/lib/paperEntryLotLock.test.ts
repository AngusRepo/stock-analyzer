import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { entrySizingLot, lockedEntryShares, relockEntryLot } from './paperEntryTasks'
import type { IntradayOHLC } from './paperIntradayData'
import { RISK_CONFIG_FIXTURE } from './riskConfig.testSupport'
import { validateOrder } from './validateOrder'

test('AUD-5 locked lot sizing never exceeds the authorized shares or the budget at the locked fill price', () => {
  // Odd lot locked: capped at 999 and at budget / fill.
  assert.equal(lockedEntryShares({ lotType: 'odd_lot', authorizedShares: 999, budget: 19_000, fillPrice: 20 }), 950)
  assert.equal(lockedEntryShares({ lotType: 'odd_lot', authorizedShares: 400, budget: 50_000, fillPrice: 20 }), 400)
  assert.equal(lockedEntryShares({ lotType: 'odd_lot', authorizedShares: 999, budget: 10, fillPrice: 20 }), null)
  // Board lot locked: whole lots only; a price rise below one lot is an explicit skip, never an odd-lot flip.
  assert.equal(lockedEntryShares({ lotType: 'board_lot', authorizedShares: 2000, budget: 45_000, fillPrice: 20 }), 2000)
  assert.equal(lockedEntryShares({ lotType: 'board_lot', authorizedShares: 2000, budget: 30_000, fillPrice: 20.5 }), 1000)
  assert.equal(lockedEntryShares({ lotType: 'board_lot', authorizedShares: 1000, budget: 20_000, fillPrice: 20.05 }), null)
  assert.equal(lockedEntryShares({ lotType: 'board_lot', authorizedShares: 1000, budget: 20_000, fillPrice: 0 }), null)
})

test('AUD-5/AUD-24 wiring: one relock to the sized lot book, fills annotated as depth VWAP', () => {
  const entry = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
  const exit = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
  const relock = entry.slice(entry.indexOf('if (authoritativeSnapshot.lotType !== lotType) {'), entry.indexOf('const requestedShares = shares'))
  assert.ok(relock.includes('await relockEntryLot({') && relock.includes('fetchOddLotL5()') && relock.includes('fetchBoardLotL5()'), 'relock fetches the sized lot book')
  assert.ok(relock.includes('finLabL5Quality = relock.quality') && relock.includes('authoritativeSnapshot = relock.snapshot'), 'relock replaces the decision inputs')
  assert.ok(!relock.includes('isOddLot ='), 'relock never flips the lot type')
  const board = entry.slice(entry.indexOf('const fetchBoardLotL5 = async () => {'), entry.indexOf('let oddLotBookChecked'))
  assert.ok(board.includes("marketDataLotType: 'board_lot'") && board.includes('quoteQualityFromL5(l5, l5Thresholds)'), 'board relock is quality-gated like odd')
  assert.ok(entry.indexOf('if (authoritativeSnapshot.lotType !== lotType) {') < entry.indexOf('const twExecutionGate = resolveTwEquityExecutionGate({'), 'relock precedes the odd-lot book gate')
  assert.ok(entry.includes("fill_model: 'authoritative_depth_vwap'") && !/\bslippage_ticks:/.test(entry), 'entry fill annotation')
  assert.equal(exit.split("fill_model: 'authoritative_depth_vwap'").length - 1, 3, 'exit depth fills (detail and both sell notes) are annotated')
  // Placement: only notes whose fill came from resolvePositionExitSellFill (depth VWAP) carry the annotation;
  // the EOD paths fill through resolveExitSellFill (1-tick model) and stay unannotated.
  const eod = exit.slice(exit.indexOf('export async function runEODExit'), exit.indexOf('export async function pollIntradayStopLoss'))
  assert.ok(eod.includes('resolveExitSellFill(quote)') && !eod.includes('fill_model'))
  const intraday = exit.slice(exit.indexOf('export async function pollIntradayStopLoss'))
  const notes = intraday.split('buildSellOrderNote({').slice(1)
  assert.equal(notes.length, 2)
  for (const [i, note] of notes.entries()) {
    assert.ok(note.slice(0, note.indexOf('})')).includes("fill_model: 'authoritative_depth_vwap'"), `intraday sell note ${i}`)
    const before = intraday.split('buildSellOrderNote({')[i]
    assert.ok(before.lastIndexOf('resolvePositionExitSellFill(') > before.lastIndexOf('resolveExitSellFill('), `intraday sell note ${i} fills from depth`)
  }
})

const book = (lotType: 'odd_lot' | 'board_lot', ask: number, extra: Partial<IntradayOHLC> = {}): IntradayOHLC => ({
  source: 'shioaji', lotType, last: ask, low: ask - 1, high: ask + 1, bid: ask - 0.05, ask, quoteAgeMs: 300,
  volumeUnit: lotType === 'odd_lot' ? 'shares' : 'lots', ...extra,
})
const pass = { status: 'pass' } as any
function relockInput(lotType: 'odd_lot' | 'board_lot', fetched: { book?: IntradayOHLC; quality: any }, over: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    input: {
      lotType, previousLotType: lotType === 'odd_lot' ? 'board_lot' : 'odd_lot', currentOhlc: book(lotType === 'odd_lot' ? 'board_lot' : 'odd_lot', 20),
      price: 20, limitPrice: 20.5, authorizedShares: lotType === 'odd_lot' ? 999 : 2000, budget: 15_000, slippageTicks: 1,
      maxAgeMs: 1500, maxDisagreementTicks: 1,
      fetchBook: async (lot: 'odd_lot' | 'board_lot') => { calls.push(lot); return { book: fetched.book, l5: null, quality: fetched.quality } },
      ...over,
    } as any,
  }
}

test('AUD-5 relock: the sized lot book is fetched once and prices the fill and the shares', async () => {
  // Pre-selected board, sized odd: the odd book prices the order; shares fit the budget at that price.
  let r = relockInput('odd_lot', { book: book('odd_lot', 20), quality: pass })
  const odd = await relockEntryLot(r.input)
  assert.deepEqual(r.calls, ['odd_lot'])
  assert.equal(odd.status, 'locked')
  if (odd.status === 'locked') {
    assert.equal(odd.snapshot.lotType, 'odd_lot')
    assert.ok(odd.shares <= 999 && odd.shares * odd.fillPrice <= 15_000 && odd.shares >= 1)
    assert.equal(odd.quality, pass)
  }
  // Pre-selected odd, sized board: whole lots on the board book.
  r = relockInput('board_lot', { book: book('board_lot', 20), quality: pass }, { budget: 50_000 })
  const board = await relockEntryLot(r.input)
  assert.deepEqual(r.calls, ['board_lot'])
  assert.equal(board.status, 'locked')
  if (board.status === 'locked') { assert.equal(board.shares, 2000); assert.equal(board.snapshot.lotType, 'board_lot') }
})

test('AUD-5 relock: a failing matching book, the wrong lot, or a budget below one lot stops without a second flip', async () => {
  for (const lot of ['odd_lot', 'board_lot'] as const) {
    const r = relockInput(lot, { book: book(lot, 20), quality: { status: 'fail', reasons: ['spread'] } }, { budget: 50_000 })
    const result = await relockEntryLot(r.input)
    assert.deepEqual([result.status, result.status !== 'locked' && result.reason],
      ['quote_unavailable', lot === 'odd_lot' ? 'l4_odd_lot_book_not_ready' : 'l4_board_lot_book_not_ready'])
    assert.deepEqual(r.calls, [lot], 'one fetch, never the other lot')
  }
  const missing = await relockEntryLot(relockInput('board_lot', { book: undefined, quality: pass }).input)
  assert.equal(missing.status, 'quote_unavailable')
  const wrongLot = await relockEntryLot(relockInput('board_lot', { book: book('odd_lot', 20), quality: pass }, { budget: 50_000 }).input)
  assert.deepEqual([wrongLot.status, wrongLot.status !== 'locked' && wrongLot.reason], ['quote_unavailable', 'execution_book_unavailable'])
  // Board sized but the board book price leaves less than one lot in budget: explicit wait, not an odd-lot flip.
  const thin = await relockEntryLot(relockInput('board_lot', { book: book('board_lot', 20.5), quality: pass }, { budget: 20_000, limitPrice: 21 }).input)
  assert.deepEqual([thin.status, thin.status !== 'locked' && thin.reason], ['checked_waiting', 'entry_lot_locked_budget_below_board_lot'])
  // Ask above the limit on the locked book: not fillable at this price.
  const above = await relockEntryLot(relockInput('odd_lot', { book: book('odd_lot', 21), quality: pass }).input)
  assert.notEqual(above.status, 'locked')
})

test('AUD-5 edge: an entry continuation below one board lot keeps an odd-lot order sized to its remainder', async () => {
  // New entry: a budget for two lots buys board lots; below one lot it is odd.
  assert.deepEqual(entrySizingLot(41_000, 20, null), { shares: 2000, isOddLot: false })
  assert.deepEqual(entrySizingLot(10_000, 20, null), { shares: 500, isOddLot: true })
  // Odd-lot partial fill leaves 499 authorized shares; a budget that could buy a lot must not turn it into
  // a board order that floors to zero, and the order is the remainder, not the whole budget.
  assert.deepEqual(entrySizingLot(41_000, 20, 499), { shares: 499, isOddLot: true })
  assert.deepEqual(entrySizingLot(5_000, 20, 499), { shares: 250, isOddLot: true })
  // A board continuation with at least one lot remaining stays board, capped at its whole remaining lots.
  assert.deepEqual(entrySizingLot(41_000, 20, 1000), { shares: 1000, isOddLot: false })
  assert.deepEqual(entrySizingLot(41_000, 20, 2500), { shares: 2000, isOddLot: false })
  // The order risk check sees the remainder: a limit above the fill price passes G5 for 499 shares.
  const odd = entrySizingLot(41_000, 20, 499)
  const g5 = await validateOrder({ symbol: '2330', side: 'buy', shares: odd.shares, limitPrice: 20.5, refClose: 20.5, avgVolume20d: 10_000_000,
    sizingAuthorization: { owner: 'sparse_allocator', authorizedValue: 41_000, portfolioValue: 1_000_000 } }, RISK_CONFIG_FIXTURE)
  assert.equal(g5.violations.some((v) => v.gate === 'G5'), false)
  const src = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
  assert.ok(src.includes('let { shares, isOddLot } = entrySizingLot(budget, fillPrice, entryContinuation?.remainingShares ?? null)'))
  // The continuation clamp still caps the order at the remaining authorized shares.
  assert.ok(src.indexOf('shares=Math.min(shares,entryContinuation.remainingShares)') > src.indexOf('entrySizingLot(budget, fillPrice'))
})
