import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openCounterfactualLot, advanceCounterfactualLot, EXIT_ARMS, type CounterfactualLot } from './paperCounterfactual'
import { applyResearchCorporateSessions, type ResearchCorporateSession } from './paperCounterfactualCorporate'
import { resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { recordCounterfactualEntry, recordCounterfactualObservation, listOpenCounterfactualLots } from './paperCounterfactualStore'
import { corporateCashEntitlement, corporateStockQuantity, type CorporateAction, type CorporateActionSnapshot } from './paperCorporateActions'
import { l4NativeFixture } from './l4NativeFixture.testSupport'

const entryDay = '2026-10-15', exDay = '2026-10-16', payDay = '2026-10-19', afterDay = '2026-10-20'
const calendar = [entryDay, exDay, payDay, afterDay]
const ms = (day: string, time = '09:25:00') => Date.parse(day + 'T' + time + '+08:00')
function book(side: 'buy' | 'sell', nowMs: number, price = 100, shares = 100, lotType: 'odd_lot' | 'board_lot' = 'odd_lot') {
  const input = { nowMs, limitPrice: price, lotType, observations: [{
    source: 'shioaji_hub' as const, lotType, bid: price, ask: price, bidPrices: [price], askPrices: [price],
    bidVolumes: [shares], askVolumes: [shares], volumeUnit: 'shares' as const, sourceTime: new Date(nowMs).toISOString(),
  }] }
  return side === 'buy' ? resolveAuthoritativeBuyExecutionSnapshot(input) : resolveAuthoritativeSellExecutionSnapshot(input)
}
function entry(shares = 100) {
  const nowMs = ms(entryDay)
  return { lotId: 'corporate-fixture', accountId: 1, symbol: '2337', date: entryDay, signalMs: nowMs, nowMs,
    observableUntilMs: nowMs + 60_000, requestedShares: shares, limitPrice: 100, entryOrLow: 95,
    snapshot: book('buy', nowMs, 100, shares, shares >= 1000 ? 'board_lot' : 'odd_lot'),
    source: { signalSha: '1'.repeat(64), modelSha: '2'.repeat(64), planId: '3'.repeat(64), l3Identity: { cohort: 'fixture' } } }
}
function action(kind: 'cash' | 'stock', perShare: number, extra: Partial<CorporateAction> = {}): CorporateAction {
  return { action_id: kind + '-1', symbol: '2337', kind, ex_date: exDay, payable_date: payDay,
    cash_per_share: kind === 'cash' ? perShare : 0, stock_per_share: kind === 'stock' ? perShare : 0, ...extra }
}
function session(day: string, actions: CorporateAction[], previousClose = 100): ResearchCorporateSession {
  const snapshot: CorporateActionSnapshot = { schema_version: 'paper-corporate-source-v1', session_date: day,
    observed_at: day + 'T08:00:00+08:00', source_checksum: '4'.repeat(64), covered_symbols: ['2337'],
    actions, blockers: {}, tax_basis: 'gross_before_personal_tax' }
  return { snapshot, previousClose: { date: calendar[calendar.indexOf(day) - 1], close: previousClose } }
}
function observation(day: string, nowMs = ms(day), price = 100) {
  return { date: day, nowMs, price, calendar, targetExit: null, z: null, closes: [],
    snapshot: book('sell', nowMs, price, 10_000), limitPrice: price }
}
function apply(lot: CounterfactualLot, day: string, sessions: ResearchCorporateSession[]) {
  return applyResearchCorporateSessions(lot, { date: day, nowMs: ms(day), calendar, sessions })
}

test('cash rights use each arm opening shares; ex-price protection, delayed payment and retries are independent', () => {
  let lot = openCounterfactualLot(entry()).lot!
  lot = advanceCounterfactualLot(lot, { ...observation(entryDay, ms(entryDay) + 1000),
    targetExit: { decisionId: 'cut', shares: 40, reason: 'reduce' }, z: -1 }).lot
  assert.deepEqual(EXIT_ARMS.map(a => lot.arms[a].shares), [60, 0, 100])
  const cash = action('cash', 10), before = JSON.stringify(lot)
  const result = advanceCounterfactualLot(lot, { ...observation(exDay, ms(exDay), 90),
    corporateSessions: [session(exDay, [cash])],
    closes: [{ date: entryDay, close: 100, observedAtMs: ms(exDay), nextSession: exDay }] })
  assert.equal(JSON.stringify(lot), before)
  assert.deepEqual(EXIT_ARMS.map(a => result.lot.arms[a].shares), [60, 0, 100])
  assert.equal(result.lot.arms.current_target.swing!.entryPrice, 90)
  assert.equal(result.lot.arms.current_target.swing!.entryOrLow, 85.5)
  assert.equal(result.lot.corporate!.arms.current_target.averageCost, 100)
  assert.equal(result.lot.corporate!.arms.current_target.rights['cash-1'].cashDue, corporateCashEntitlement(60, cash))
  assert.equal(result.lot.corporate!.arms.or15_only.rights['cash-1'].cashDue, 1000)
  assert.equal(Object.keys(result.lot.corporate!.arms.z_hysteresis.rights).length, 0)
  const repeat = apply(result.lot, exDay, [session(exDay, [cash])])
  assert.equal(repeat.arms.current_target.swing!.entryPrice, 90)
  assert.equal(repeat.corporate!.arms.current_target.deliveredCash, 0)
  const paid = apply(repeat, payDay, [session(payDay, [cash])])
  assert.deepEqual(EXIT_ARMS.map(a => paid.corporate!.arms[a].deliveredCash), [600, 0, 1000])
  assert.deepEqual(apply(paid, payDay, [session(payDay, [cash])]), paid)
  assert.deepEqual(apply(paid, afterDay, [session(afterDay, [cash])]).corporate!.arms.current_target, paid.corporate!.arms.current_target)
})

test('stock rights remain receivable until delivery; sold-out arm restores its own basis and exact decimal rounding', () => {
  const lot = openCounterfactualLot(entry()).lot!, stock = action('stock', .29)
  const accrued = apply(lot, exDay, [session(exDay, [stock])])
  assert.deepEqual(EXIT_ARMS.map(a => accrued.arms[a].shares), [100, 100, 100])
  assert.equal(accrued.corporate!.arms.current_target.rights['stock-1'].wholeSharesDue, corporateStockQuantity(100, .29).whole)
  const sold = advanceCounterfactualLot(accrued, { ...observation(exDay, ms(exDay) + 1000, 77.6), z: -1,
    targetExit: { decisionId: 'cut', shares: 40, reason: 'reduce' } }).lot
  assert.deepEqual(EXIT_ARMS.map(a => sold.arms[a].shares), [60, 0, 100])
  const paid = apply(sold, payDay, [session(payDay, [stock], 77.6)])
  assert.deepEqual(EXIT_ARMS.map(a => paid.arms[a].shares), [89, 29, 129])
  assert.equal(paid.arms.z_hysteresis.swing!.entryPrice, 100 / 1.29)
  assert.equal(paid.arms.z_hysteresis.swing!.entryDate, entryDay)
  assert.equal(paid.corporate!.arms.z_hysteresis.averageCost, 100 / 1.29)
  assert.equal(paid.corporate!.arms.z_hysteresis.lastShareChangeMs, ms(payDay))
  assert.equal(paid.arms.current_target.consumedTarget, null)
  assert.deepEqual(apply(paid, payDay, [session(payDay, [stock], 77.6)]), paid)
})

test('missing delivery terms preserves pending rights and cash; later official terms settle without inventing fractions', () => {
  const lot = openCounterfactualLot(entry(7)).lot!
  const cash = action('cash', .15), stock = action('stock', .29)
  const accrued = apply(lot, exDay, [session(exDay, [cash, stock])])
  const before = JSON.stringify(accrued)
  assert.throws(() => apply(accrued, payDay, [session(payDay, [cash, stock])]), /cash_rounding_terms_missing/)
  assert.equal(JSON.stringify(accrued), before)
  const rounded = { ...cash, cash_rounding: 'floor_twd' as const }
  assert.throws(() => apply(accrued, payDay, [session(payDay, [rounded, stock])]), /fractional_delivery_terms_missing/)
  assert.equal(JSON.stringify(accrued), before)
  const paid = apply(accrued, payDay, [session(payDay, [rounded, { ...stock, fractional_treatment: 'book_entry_fee' }])])
  for (const arm of EXIT_ARMS) {
    assert.equal(paid.corporate!.arms[arm].deliveredCash, 1)
    assert.equal(paid.arms[arm].shares, 9)
    assert.equal(paid.corporate!.arms[arm].rights['stock-1'].sharesDue, 2.03)
    assert.equal(paid.corporate!.arms[arm].rights['stock-1'].wholeSharesDue, 2)
  }
})

test('no guess on legacy basis, future evidence, wrong close, changed source or unsupported actions', () => {
  const lot = openCounterfactualLot(entry()).lot!, cash = action('cash', 10), s = session(exDay, [cash])
  assert.throws(() => apply({ ...lot, corporate: undefined }, exDay, [s]), /entry_ownership_basis_missing/)
  assert.throws(() => apply(lot, exDay, [{ ...s, previousClose: null }]), /exact_previous_close_missing/)
  assert.throws(() => apply(lot, exDay, [{ ...s, previousClose: { date: '2026-10-14', close: 100 } }]), /exact_previous_close_missing/)
  assert.throws(() => apply(lot, exDay, [{ ...s, previousClose: { date: exDay, close: 100 } }]), /exact_previous_close_missing/)
  assert.throws(() => apply(lot, exDay, [{ ...s, snapshot: { ...s.snapshot, observed_at: exDay + 'T12:00:00+08:00' } }]), /source_invalid/)
  const legacy = structuredClone(lot)
  legacy.corporate!.arms.current_target.lastShareChangeMs = ms(exDay, '09:01:00')
  assert.throws(() => apply(legacy, exDay, [s]), /opening_basis_missing/)
  const done = apply(lot, exDay, [s])
  assert.throws(() => apply(done, exDay, [session(exDay, [{ ...cash, cash_per_share: 11 }])]), /same_session_source_changed/)
  assert.throws(() => apply(done, payDay, [session(payDay, [])]), /outstanding_terms_missing_or_changed/)
  const exchange: CorporateAction = { ...action('stock', 1), kind: 'exchange', payable_date: exDay }
  assert.throws(() => apply(lot, exDay, [session(exDay, [exchange])]), /unsupported_action/)
  assert.throws(() => apply(lot, payDay, [session(payDay, [cash])]), /historical_action_basis_required/)
})

test('missed multiple sessions after stock delivery stays blocked; no backdated ownership or partial cash credit', () => {
  const lot = openCounterfactualLot(entry()).lot!, stock = action('stock', .1), cash = action('cash', 1)
  const accrued = apply(lot, exDay, [session(exDay, [stock, cash])])
  const before = JSON.stringify(accrued)
  const result = advanceCounterfactualLot(accrued, { ...observation(afterDay),
    corporateSessions: [session(payDay, [stock, cash]), session(afterDay, [stock, cash])],
    closes: [{ date: payDay, close: 80, observedAtMs: ms(afterDay), nextSession: afterDay }] })
  assert.ok(result.events.every(e => e.reason.includes('opening_basis_missing:' + afterDay)))
  assert.deepEqual(result.lot.corporate, accrued.corporate)
  assert.deepEqual(result.lot.arms, accrued.arms)
  assert.equal(JSON.stringify(accrued), before)
  assert.equal(result.lot.lastObservedMs, ms(afterDay))
})

test('delivery keeps partial/full exits separate and splits board/odd depth per arm without substitution', () => {
  const lot = openCounterfactualLot(entry(1000)).lot!, stock = action('stock', .1)
  const accrued = apply(lot, exDay, [session(exDay, [stock])])
  accrued.arms.current_target.pending = { reason: 'reduce', remainingShares: 40, triggeredAtMs: ms(exDay) }
  accrued.arms.z_hysteresis.pending = { reason: 'z_below_zero', remainingShares: 1000, triggeredAtMs: ms(exDay) }
  const paid = apply(accrued, payDay, [session(payDay, [stock])])
  assert.equal(paid.arms.current_target.pending!.remainingShares, 40)
  assert.equal(paid.arms.z_hysteresis.pending!.remainingShares, 1100)
  const now = ms(payDay) + 1000
  const board = { snapshot: book('sell', now, 91, 1000, 'board_lot'), limitPrice: 91, price: 91 }
  const first = advanceCounterfactualLot(paid, { ...observation(payDay, now, 91), exitBooks: { board_lot: board } })
  assert.equal(first.events.find(e => e.arm === 'current_target')!.reason, 'execution_book_missing')
  assert.equal(first.lot.arms.current_target.shares, 1100)
  assert.equal(first.lot.arms.z_hysteresis.shares, 100)
  const later = now + 1000, odd = { snapshot: book('sell', later, 91, 100), limitPrice: 91, price: 91 }
  const done = advanceCounterfactualLot(first.lot, { ...observation(payDay, later, 91), exitBooks: { odd_lot: odd } })
  assert.equal(done.lot.arms.current_target.shares, 1060)
  assert.equal(done.lot.arms.z_hysteresis.shares, 0)
  assert.equal(done.lot.arms.or15_only.shares, 1100)
})

test('a delivery-time book arriving after the observation stays unobservable; next tick fills without paying twice', () => {
  const actions = [action('stock', .1), action('cash', 1)], lot = openCounterfactualLot(entry()).lot!
  const accrued = apply(lot, exDay, [session(exDay, actions)])
  const now = ms(payDay), future = now + 1000
  const first = advanceCounterfactualLot(accrued, { ...observation(payDay, now, 90), z: -1,
    corporateSessions: [session(payDay, actions)], snapshot: book('sell', future, 90, 1000) })
  assert.equal(first.events.find(e => e.arm === 'z_hysteresis')!.reason, 'execution_book_identity_or_clock_mismatch')
  assert.equal(first.lot.arms.z_hysteresis.shares, 110)
  assert.equal(first.lot.corporate!.arms.z_hysteresis.deliveredCash, 100)
  const done = advanceCounterfactualLot(first.lot, { ...observation(payDay, future, 90), z: 1,
    corporateSessions: [session(payDay, actions)], snapshot: book('sell', future, 90, 1000) })
  assert.equal(done.lot.arms.z_hysteresis.shares, 0)
  assert.equal(done.lot.arms.z_hysteresis.proceeds, 110 * 90)
  assert.equal(done.lot.corporate!.arms.z_hysteresis.deliveredCash, 100)
  assert.equal(done.lot.corporate!.arms.z_hysteresis.rights['stock-1'].settledAtMs, now)
})

test('closed shares with unpaid rights remain pollable; CAS receipt holds economic basis and production ledger stays unchanged', async () => {
  const f = l4NativeFixture()
  try {
    f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0012_counterfactual_recorder.sql', import.meta.url), 'utf8'))
    const before = f.sqls.paper.prepare('SELECT * FROM paper_accounts').all(), db = f.env.PAPER_DB
    const opened = (await recordCounterfactualEntry(db, entry())).stored!
    const cash = action('cash', 10)
    const exInput = { ...observation(exDay, ms(exDay), 80), corporateSessions: [session(exDay, [cash])] }
    const closed = await recordCounterfactualObservation(db, opened, exInput)
    assert.ok(EXIT_ARMS.every(arm => closed.lot.arms[arm].shares === 0))
    assert.equal((await listOpenCounterfactualLots(db, 1)).length, 1)
    assert.deepEqual((await recordCounterfactualObservation(db, opened, exInput)).stored, closed.stored)
    const payInput = { ...observation(payDay), corporateSessions: [session(payDay, [cash])] }
    const paid = await recordCounterfactualObservation(db, closed.stored, payInput)
    assert.deepEqual(EXIT_ARMS.map(arm => paid.lot.corporate!.arms[arm].deliveredCash), [1000, 1000, 1000])
    assert.equal((await listOpenCounterfactualLots(db, 1)).length, 0)
    const row = f.sqls.paper.prepare('SELECT evidence_json FROM paper_counterfactual_events_v1 WHERE version=2').get()
    assert.equal(JSON.parse(String(row?.evidence_json)).input.corporateSessions[0].snapshot.source_checksum, '4'.repeat(64))
    assert.equal(paid.lot.corporate!.sessions[exDay].opening.or15_only.shares, 100)
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_accounts').all(), before)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_orders').get()?.n, 0)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions').get()?.n, 0)
  } finally { f.close() }
})
