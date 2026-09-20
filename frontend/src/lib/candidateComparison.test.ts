import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { commissionTotals, scheduledRebateDate, estimatedRebate, rebateView } from './candidateComparison'

test('research evidence preserves all matched scenarios and independently verified ledgers', () => {
  const data = JSON.parse(readFileSync(new URL('../data/candidateComparisonResearch.json', import.meta.url), 'utf8'))
  assert.equal(data.kind, 'frozen_research_replay')
  assert.equal(data.promotion_credit, false)
  assert.equal(data.scenarios.length, 10)
  for (const scenario of data.scenarios) {
    assert.deepEqual(scenario.accounts.primary.ledger.map((d: { date: string }) => d.date), scenario.accounts.challenger.ledger.map((d: { date: string }) => d.date))
    for (const role of ['primary', 'challenger']) {
      const account = scenario.accounts[role]
      assert.match(account.sha256, /^[a-f0-9]{64}$/)
      assert.equal(account.fills.reduce((sum: number, f: { commission: number; tax: number }) => sum + f.commission + f.tax, 0), account.summary.fees_and_tax)
      assert.ok(Math.abs(account.ledger.at(-1).nav / data.initial_cash - 1 - account.summary.net_return) < 1e-10)
    }
  }
})

test('new page separates accepted research candidates from prospective paired NAV', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
  const page = read('../components/StrategyCandidateComparison.tsx')
  assert.ok(read('../components/NavTradingRoom.tsx').includes('<StrategyCandidateComparison/>'))
  assert.ok(page.includes('研究回放 · 固定快照'))
  assert.ok(page.includes('尚未接入這兩個候選的每日配對帳本'))
  assert.ok(page.includes('137 外生特徵 TimeXer'))
  assert.ok(page.includes('價格 TimeXer'))
  assert.ok(!page.includes('apiPost'))
})

test('cost categories and nominal monthly date remain separate from rebate receipts', () => {
  assert.deepEqual(commissionTotals([{ commission: 20, tax: 30, slippage_cost: 2 }, { commission: 100, tax: 0, slippage_cost: 3 }]), { commission: 120, tax: 30, slippage: 5 })
  assert.throws(() => commissionTotals([{ commission: NaN, tax: 0, slippage_cost: 0 }]))
  assert.equal(scheduledRebateDate('2026-08'), '2026-09-10')
  assert.equal(scheduledRebateDate('2026-12'), '2027-01-10')
  assert.throws(() => scheduledRebateDate('2026-13'))
})

test('confirmed 25 percent rate preserves a final20 minimum and never rebates tax', () => {
  assert.equal(estimatedRebate(20), 0)
  assert.equal(estimatedRebate(40), 20)
  assert.equal(estimatedRebate(80), 60)
  assert.equal(estimatedRebate(100), 75)
  assert.throws(() => estimatedRebate(-1))
  const account = {
    ledger: [
      { date: '2026-08-31', nav: 1000, cash: 400, exposure: .6, positions: 1, symbols: ['A'] },
      { date: '2026-09-10', nav: 900, cash: 350, exposure: .6, positions: 1, symbols: ['A'] },
    ],
    fills: [
      { date: '2026-08-31', commission: 100, tax: 0, slippage_cost: 2 },
      { date: '2026-09-10', commission: 40, tax: 300, slippage_cost: 2 },
    ],
  }
  const before = JSON.stringify(account)
  const result = rebateView(account, 1000)
  assert.equal(result.estimated_rebate, 95)
  assert.equal(result.latest.adjusted_nav, 995)
  assert.equal(result.latest.cash, 350)
  assert.equal(result.tax, 300)
  assert.equal(result.net_commission, 45)
  assert.equal(result.confirmed_rebate_received, null)
  assert.equal(result.months[0].scheduled_date, '2026-09-10')
  assert.equal(result.months[1].scheduled_date, '2026-10-10')
  assert.equal(result.months[1].estimated_rebate, 20)
  assert.ok(Math.abs(result.adjusted_drawdown - (995 / 1075 - 1)) < 1e-12)
  assert.equal(JSON.stringify(account), before)
})

test('20 real ledgers reconcile and key rebate results match independent Python totals', () => {
  const data = JSON.parse(readFileSync(new URL('../data/candidateComparisonResearch.json', import.meta.url), 'utf8'))
  const expected = { '2026-08-05_5': { primary: 5324.5, challenger: 13557.5 }, '2026-09-02_5': { primary: 2317.75, challenger: 5949.75 } }
  for (const scenario of data.scenarios) for (const role of ['primary', 'challenger']) {
    const account = scenario.accounts[role], result = rebateView(account, data.initial_cash)
    assert.equal(result.commission + result.tax, account.summary.fees_and_tax)
    assert.equal(result.latest.cash, account.ledger.at(-1).cash)
    assert.ok(Math.abs(result.gross_drawdown - account.summary.max_drawdown) < 1e-10)
    assert.ok(Math.abs(result.latest.gross_return - account.summary.net_return) < 1e-10)
    if (expected[scenario.id]) assert.equal(result.estimated_rebate, expected[scenario.id][role])
    assert.equal(result.months.reduce((sum, month) => sum + month.estimated_rebate, 0), result.estimated_rebate)
  }
})

test('missing or invalid evidence cannot silently become a comparable adjusted NAV', () => {
  assert.throws(() => rebateView({ ledger: [], fills: [] }, 1000))
  const day = { date: '2026-01-01', nav: 1000, cash: 1000, exposure: 0, positions: 0, symbols: [] }
  assert.throws(() => rebateView({ ledger: [day, day], fills: [] }, 1000))
  assert.throws(() => rebateView({ ledger: [{ ...day, nav: NaN }], fills: [] }, 1000))
  assert.throws(() => rebateView({ ledger: [day], fills: [{ date: '2026-01-02', commission: 20, tax: 0, slippage_cost: 0 }] }, 1000))
})
