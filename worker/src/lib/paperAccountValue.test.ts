import { computePaperPositionValuation, computePaperTotalValue, requireCompletePaperPositionValue, getUnsettledSettlementSummary } from './paperAccountValue'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

for (const field of ['settledCash', 'positionsValue', 'netUnsettledSettlement']) {
  for (const invalid of [null, NaN, Infinity, '', true]) {
    let blocked = false
    try { computePaperTotalValue({ settledCash: 100, positionsValue: 20, netUnsettledSettlement: 0,
      [field]: invalid } as never) } catch { blocked = true }
    assert(blocked, `${field} ${String(invalid)} must not silently become zero NAV`)
  }
}
assert(computePaperTotalValue({ settledCash: 100, positionsValue: 0 }) === 100, 'explicit cash-only account remains valid')
for (const invalid of [true, '100', null, NaN, Infinity, -1, 0]) {
  let blocked = false
  try { requireCompletePaperPositionValue([{symbol: '2330', shares: 100}], new Map([['2330', invalid]]) as never) }
  catch { blocked = true }
  assert(blocked, 'complete NAV cannot coerce an invalid mark into a real stock price')
}
{
  let blocked = false
  try { requireCompletePaperPositionValue([{symbol: '2330', shares: 100}, {symbol: ' 2330 ', shares: 100}], new Map([['2330', 100]])) }
  catch { blocked = true }
  assert(blocked, 'symbol normalization cannot make duplicate holdings appear distinct')
}
for (const positions of [[{symbol: '2330', shares: 1.5}], [{symbol: '2330', shares: 100}, {symbol: '2330', shares: 100}]]) {
  let blocked = false
  try { requireCompletePaperPositionValue(positions, new Map([['2330', 100]])) } catch { blocked = true }
  assert(blocked, 'fractional or duplicate holdings cannot inflate NAV')
}

async function checkSettlementRead() {
  for (const row of [null, {unsettled_buy_amount: null, unsettled_sell_amount: 0, invalid_amount_rows: 0},
    {unsettled_buy_amount: 0, unsettled_sell_amount: 0, invalid_amount_rows: 1}]) {
    const db = { prepare: () => ({bind: () => ({first: async () => row})}) } as unknown as D1Database
    let blocked = false
    try { await getUnsettledSettlementSummary(db, 1) } catch { blocked = true }
    assert(blocked, 'missing aggregate must not become a zero-liability receipt')
  }
  const db = { prepare: () => ({bind: () => ({first: async () => ({unsettled_buy_amount: 0, unsettled_sell_amount: 0, invalid_amount_rows: 0})})}) } as unknown as D1Database
  assert((await getUnsettledSettlementSummary(db, 1)).netUnsettledSettlement === 0, 'real empty aggregate is valid')
}
void checkSettlementRead().catch(error => { setTimeout(() => { throw error }, 0) })

{
  const positions = [{ symbol: '2330', shares: 100 }, { symbol: '6530', shares: 20 }]
  const prices = new Map([['2330', 1000]])
  let error = ''
  try { requireCompletePaperPositionValue(positions, prices) } catch (caught) { error = String(caught) }
  assert(error.includes('held_marks_missing:6530'), 'missing held stock must block a persisted NAV')
  prices.set('6530', 200)
  assert(requireCompletePaperPositionValue(positions, prices) === 104000, 'complete retry values every holding')
  assert(requireCompletePaperPositionValue([], new Map()) === 0, 'actual cash-only account has zero position value')
  for (const invalid of [NaN, Infinity, -1]) {
    let blocked = false
    try { requireCompletePaperPositionValue([{ symbol: '2330', shares: invalid }], prices) } catch { blocked = true }
    assert(blocked, 'invalid holding cannot be dropped from NAV')
  }
}

{
  const value = computePaperTotalValue({
    settledCash: 1_000_000,
    positionsValue: 46_110,
    netUnsettledSettlement: -46_176,
  })
  assert(value === 999_934, 'unsettled buy payable must offset newly opened position value')
}

{
  const value = computePaperTotalValue({
    settledCash: 1_000_000,
    positionsValue: 0,
    netUnsettledSettlement: 111_504,
  })
  assert(value === 1_111_504, 'unsettled sell receivable should count in economic account value')
}

{
  const valuation = computePaperPositionValuation({
    positions: [
      { symbol: '2404', shares: 85 },
      { symbol: '6691', shares: 144 },
      { symbol: 'MISSING', shares: 1000 },
    ],
    quotePrices: new Map([['2404', 1385]]),
    fallbackPrices: new Map([['6691', 766]]),
  })
  assert(valuation.positionsValue === 228_029, 'position valuation should include quote and fallback prices')
  assert(valuation.symbolPrices.get('2404') === 1385, 'quote price should be preferred')
  assert(valuation.symbolPrices.get('6691') === 766, 'fallback close should price quote-missing holdings')
  assert(valuation.quoteSymbols.join(',') === '2404', 'quote-sourced symbols should be exposed')
  assert(valuation.fallbackSymbols.join(',') === '6691', 'fallback-sourced symbols should be exposed')
  assert(valuation.missingSymbols.join(',') === 'MISSING', 'unpriced holdings should be explicit instead of silently zeroed')
}
