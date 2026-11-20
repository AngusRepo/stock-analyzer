import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildStockData } from './marketScreener'
import { loadMarketDataFromD1 } from './screenerMarketData'

// NEW-1030-11: canonical chips own every (stock,date) they report; legacy chip_data only fills pairs canonical
// lacks entirely, under the English names, so a filled day counts and a covered day keeps its canonical source.

const D0 = '2026-11-13', D1 = '2026-11-16', D2 = '2026-11-17', D3 = '2026-11-18'
const nulls = { foreign_buy: null, foreign_sell: null, trust_buy: null, trust_sell: null, dealer_buy: null, dealer_sell: null }
const LEGACY = [
  { ...nulls, symbol: '2330', date: D0, foreign_buy: 9, foreign_sell: 0 },
  { ...nulls, symbol: '2330', date: D1, foreign_buy: 900, foreign_sell: 0 },
  { ...nulls, symbol: '2330', date: D2, foreign_buy: 700, foreign_sell: 0, trust_buy: 100, trust_sell: 0 },
  { ...nulls, symbol: '2317', date: D2, foreign_buy: 300, foreign_sell: 100 },
  { symbol: '2330', date: D3, foreign_buy: 400, foreign_sell: 0, trust_buy: 50, trust_sell: 0, dealer_buy: 10, dealer_sell: 0 },
]
const canonicalRow = (stock_id: string, date: string, foreign_net: number | null, trust_net: number | null, dealer_net: number | null) =>
  ({ stock_id, date, market_segment: 'LISTED', foreign_net, trust_net, dealer_net, source: 'finlab.institutional_investors_trading_summary' })
const CANONICAL = [
  canonicalRow('2330', D1, 1000, 0, 0),
  // Zero nets: netToChip drops every row, but canonical still owns the day.
  canonicalRow('2330', D2, 0, 0, 0),
  // FinLab margin-only row: foreign/trust null, dealer_net a filled 0. Legacy may still fill this pair.
  { ...canonicalRow('1101', D2, null, null, 0), margin_balance: 5000 },
]
const brokerRow = (date: string, net_shares: number) => ({ stock_id: '2330', date, market_segment: 'LISTED', net_shares,
  estimated_amount: null, broker_count: 3, concentration: 0.4, source: 'finlab.broker_transactions' })
const BROKER = [brokerRow(D2, 50), brokerRow(D3, 20)]

// rows: canonical present; empty: tables exist but hold nothing; noColumn: the full canonical SELECT fails and the
// reduced SELECT answers; noTable: every canonical read throws.
type CanonicalMode = 'rows' | 'empty' | 'noColumn' | 'noTable'

function fakeEnv(mode: CanonicalMode) {
  const canonical = mode !== 'empty'

  const LEGACY_1101 = { ...nulls, symbol: '1101', date: D2, trust_buy: 70, trust_sell: 0 }
  const answer = (sql: string): unknown[] => {
    if (/DISTINCT date FROM stock_prices/.test(sql)) return [D3, D2, D1, D0].map((date) => ({ date }))
    if (/FROM stock_prices/.test(sql)) return []
    if (/DISTINCT date FROM chip_data/.test(sql)) return [D3, D2, D1, D0].map((date) => ({ date }))
    if (/FROM chip_data/.test(sql)) return [...LEGACY, LEGACY_1101]
    if (/canonical_/.test(sql) && mode === 'noTable') throw new Error('D1_ERROR: no such table')
    if (/DISTINCT date FROM canonical_chip_daily/.test(sql)) return canonical ? [{ date: D2 }, { date: D1 }] : []
    if (/margin_prev_balance/.test(sql) && mode === 'noColumn') throw new Error('D1_ERROR: no such column: margin_prev_balance')
    if (/FROM canonical_chip_daily/.test(sql)) return canonical ? CANONICAL : []
    if (/DISTINCT date FROM canonical_broker_flow_daily/.test(sql)) return canonical ? [{ date: D3 }, { date: D2 }] : []
    if (/FROM canonical_broker_flow_daily/.test(sql)) return canonical ? BROKER : []
    throw new Error(`unexpected sql: ${sql}`)
  }
  const DB = { prepare: (sql: string) => {
    const st: any = { bind: () => st, all: async () => ({ results: answer(sql), success: true }) }
    return st
  } }
  return { DB } as any
}

test('NEW-1030-11: a canonical (stock,date) skips every legacy row, zero-net days included, and keeps its source', async () => {
  // chipDays=2: the canonical window [D1,D2] is LIMIT-truncated, so D0 was never queried there.
  const data = await loadMarketDataFromD1(fakeEnv('rows'), 20, 2, D3)
  const legacyPairs = data.allChips.filter((c) => c.source === 'legacy.chip_data').map((c) => `${c.stock_id}|${c.date}|${c.name}`)
  assert.deepEqual(legacyPairs.sort(), [
    `1101|${D2}|trust`, `2317|${D2}|foreign`, `2330|${D3}|dealer`, `2330|${D3}|foreign`, `2330|${D3}|trust`,
  ])
  assert.ok(data.allChips.every((c) => ['foreign', 'trust', 'dealer', 'broker_flow', 'margin_balance'].includes(c.name)))
  assert.equal(data.chipSourceSummary['legacy.chip_data'], 5)

  const { chips } = buildStockData([], data.allChips)
  const day = (stock: string, date: string) => chips.get(stock)?.get(date)
  // Covered with a non-zero canonical net: canonical value, canonical source.
  assert.deepEqual([day('2330', D1)?.foreign, day('2330', D1)?.source], [1000, 'finlab.institutional_investors_trading_summary'])
  // Covered with zero nets: the legacy 700/100 is not added and the broker source is not overwritten.
  const zero = day('2330', D2)!
  assert.deepEqual([zero.foreign, zero.trust, zero.brokerFlow, zero.source], [0, 0, 50, 'finlab.broker_transactions'])
  // Canonical window starts at D1: an older legacy day is not filled.
  assert.equal(day('2330', D0), undefined)
})

test('NEW-1030-11: a day canonical lacks entirely is filled from legacy and its nets count', async () => {
  const data = await loadMarketDataFromD1(fakeEnv('rows'), 20, 2, D3)
  const { chips } = buildStockData([], data.allChips)
  // Institutional nets come from legacy; the canonical broker row is written last and keeps the day's source.
  const filled = chips.get('2330')!.get(D3)!
  assert.deepEqual([filled.foreign, filled.trust, filled.dealer, filled.brokerFlow, filled.source],
    [400, 50, 10, 20, 'finlab.broker_transactions'])
  // Partial day: canonical has D2 for other stocks but not for 2317, so 2317 D2 is filled.
  assert.deepEqual([chips.get('2317')!.get(D2)!.foreign, chips.get('2317')!.get(D2)!.source], [200, 'legacy.chip_data'])
  // A canonical row without any institutional net does not own the pair.
  assert.equal(chips.get('1101')!.get(D2)!.trust, 70)
  assert.equal(data.chipFreshness.latestInstitutionalChipDate, D3)
})

test('NEW-1030-11: a sparse canonical window (fewer dates than chipDays) does not cut older legacy days', async () => {
  const data = await loadMarketDataFromD1(fakeEnv('rows'), 20, 5, D3)
  const { chips } = buildStockData([], data.allChips)
  assert.deepEqual([chips.get('2330')!.get(D0)!.foreign, chips.get('2330')!.get(D1)!.foreign], [9, 1000])
})

test('NEW-1030-11: with no canonical chips legacy fills every day under the English names', async () => {
  for (const mode of ['empty', 'noTable'] as const) {
    const data = await loadMarketDataFromD1(fakeEnv(mode), 20, 5, D3)
    assert.ok(data.allChips.every((c) => c.source === 'legacy.chip_data'), mode)
    assert.equal(data.allChips.length, 9, mode)
    const { chips } = buildStockData([], data.allChips)
    assert.deepEqual([D0, D1, D2, D3].map((date) => chips.get('2330')!.get(date)!.foreign), [9, 900, 700, 400], mode)
    assert.equal(chips.get('2330')!.get(D2)!.trust, 100, mode)
  }
})

test('NEW-1030-11: the reduced canonical SELECT still decides coverage', async () => {
  const data = await loadMarketDataFromD1(fakeEnv('noColumn'), 20, 2, D3)
  const legacyPairs = data.allChips.filter((c) => c.source === 'legacy.chip_data').map((c) => `${c.stock_id}|${c.date}`)
  assert.deepEqual([...new Set(legacyPairs)].sort(), [`1101|${D2}`, `2317|${D2}`, `2330|${D3}`])
})

test('NEW-1030-11: a stock with no taxonomy or industry mapping falls back to 未分類 so the controller sector cap still applies', () => {
  const screener = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  const fallbacks = screener.split('\n').filter((line) => line.includes('taxonomyDisplay(taxonomy, industryMap.get(stockId)'))
  assert.equal(fallbacks.length, 2)
  for (const line of fallbacks) assert.ok(line.includes("industryMap.get(stockId) ?? '未分類')"), line.trim())
  assert.ok(!screener.includes('?嗡?'))
})
