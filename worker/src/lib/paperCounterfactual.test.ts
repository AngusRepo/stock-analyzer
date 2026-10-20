import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAuthoritativeBuyExecutionSnapshot, resolveAuthoritativeSellExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { openCounterfactualLot, advanceCounterfactualLot, EXIT_ARMS } from './paperCounterfactual'
const date = '2026-10-15', next = '2026-10-16'
const now = Date.parse(date + 'T09:25:00+08:00')
function book(side: 'buy' | 'sell', ms = now, price = 100, shares = 100, sourceMs = ms) {
  const input = { nowMs: ms, limitPrice: price, lotType: 'odd_lot' as const, observations: [{
    source: 'shioaji_hub' as const, lotType: 'odd_lot' as const, bid: price, ask: price,
    bidPrices: [price], askPrices: [price], bidVolumes: [shares], askVolumes: [shares],
    sourceTime: new Date(sourceMs).toISOString(), volumeUnit: 'shares' as const,
  }] }
  return side === 'buy' ? resolveAuthoritativeBuyExecutionSnapshot(input) : resolveAuthoritativeSellExecutionSnapshot(input)
}
function entry() {
  return { lotId: 'fixture', accountId: 1, symbol: '2337', date, signalMs: now, nowMs: now,
    observableUntilMs: now + 60_000, requestedShares: 100, limitPrice: 100, entryOrLow: 95,
    source: { signalSha: '1'.repeat(64), modelSha: '2'.repeat(64), planId: '3'.repeat(64), l3Identity: { cohort: 'fixture' } }, snapshot: book('buy') }
}
function observation(ms = now + 1000) {
  return { date, nowMs: ms, price: 100, calendar: [date, next], targetExit: { decisionId: 'plan-1', shares: 0, reason: 'retain' },
    z: null as number | null, closes: [], snapshot: book('sell', ms), limitPrice: 100 }
}
test('only observed depth opens a lot; no late, previous, missing or mismatched book credit', () => {
  const input = entry(), original = JSON.stringify(input)
  const lot = openCounterfactualLot(input).lot!
  assert.equal(lot.entryShares, 100); assert.equal(JSON.stringify(input), original)
  assert.equal(openCounterfactualLot({ ...input, snapshot: null }).lot, null)
  assert.equal(openCounterfactualLot({ ...input, nowMs: now + 60_000 }).reason, 'signal_observation_window_missed')
  assert.equal(openCounterfactualLot({ ...input, snapshot: book('buy', now, 100, 100, now - 1) }).lot, null)
  assert.equal(openCounterfactualLot({ ...input, snapshot: book('sell') }).lot, null)
  assert.throws(() => openCounterfactualLot({ ...input, source: { ...input.source, signalSha: '' } }), /contract_invalid/)
})
test('partial entry is shared but each policy remains independent; null z never sells', () => {
  const lot = openCounterfactualLot({ ...entry(), snapshot: book('buy', now, 100, 50) }).lot!
  const before = JSON.stringify(lot)
  const result = advanceCounterfactualLot(lot, { ...observation(), targetExit: { decisionId: 'cut-1', shares: 50, reason: 'target_zero' } })
  assert.equal(result.lot.arms.current_target.shares, 0)
  assert.equal(result.lot.arms.z_hysteresis.shares, 50)
  assert.equal(result.lot.arms.or15_only.shares, 50)
  assert.equal(result.events.find(e => e.arm === 'z_hysteresis')!.reason, 'z_missing')
  assert.equal(JSON.stringify(lot), before)
  assert.throws(() => advanceCounterfactualLot(lot, { ...observation(), z: NaN }), /contract_invalid/)
})
test('unfilled exit persists after z rebounds; same depth cannot be consumed twice', () => {
  const lot = openCounterfactualLot(entry()).lot!
  const first = advanceCounterfactualLot(lot, { ...observation(), z: -1, snapshot: null }).lot
  assert.equal(first.arms.z_hysteresis.pending?.remainingShares, 100)
  const partial = advanceCounterfactualLot(first, { ...observation(now + 2000), z: 2, snapshot: book('sell', now + 2000, 100, 40) }).lot
  assert.equal(partial.arms.z_hysteresis.shares, 60)
  const repeat = advanceCounterfactualLot(partial, { ...observation(now + 2500), z: 2, snapshot: book('sell', now + 2500, 100, 40, now + 2000) })
  assert.equal(repeat.events.find(e => e.arm === 'z_hysteresis')!.reason, 'depth_already_consumed')
  const done = advanceCounterfactualLot(repeat.lot, { ...observation(now + 3000), z: 2 }).lot
  assert.equal(done.arms.z_hysteresis.shares, 0); assert.equal(done.arms.z_hysteresis.proceeds, 10_000)
})
test('a completed target reduction cannot be submitted again under the same decision id', () => {
  const lot = openCounterfactualLot(entry()).lot!
  const targetExit = { decisionId: 'reduce-40', shares: 40, reason: 'target_reduce' }
  const first = advanceCounterfactualLot(lot, { ...observation(), targetExit }).lot
  const second = advanceCounterfactualLot(first, { ...observation(now + 2000), targetExit }).lot
  assert.equal(second.arms.current_target.shares, 60)
})
test('cross-day ORL sell is independent of z and requires an observed executable book', () => {
  const lot = openCounterfactualLot(entry()).lot!, ms = Date.parse(next + 'T09:05:00+08:00')
  const result = advanceCounterfactualLot(lot, { ...observation(ms), date: next, price: 94, limitPrice: 94,
    snapshot: book('sell', ms, 94), closes: [{ date, close: 94, observedAtMs: Date.parse(date + 'T13:30:00+08:00'), nextSession: next }] })
  for (const arm of EXIT_ARMS) assert.equal(result.lot.arms[arm].shares, 0)
  assert.ok(result.events.every(e => e.reason === 'swing_daily_orl' && e.z === null))
})
test('price protection works without calendar; future close and clock regression fail', () => {
  const lot = openCounterfactualLot(entry()).lot!
  const stop = advanceCounterfactualLot(lot, { ...observation(), price: 92, limitPrice: 92, calendar: [], snapshot: book('sell', now + 1000, 92) })
  assert.ok(stop.events.every(e => e.reason === 'swing_hard_stop_8'))
  assert.throws(() => advanceCounterfactualLot(lot, observation(now)), /contract_invalid/)
  assert.throws(() => advanceCounterfactualLot(lot, { ...observation(), closes: [{date, close: 94, observedAtMs: now + 2000, nextSession: next}] }), /future_close/)
})


test('durable cross-day continuation, retry, CAS conflict and account isolation use only research tables', async () => {
  const { l4NativeFixture } = await import('./l4NativeFixture.testSupport')
  const { readFileSync } = await import('node:fs')
  const { recordCounterfactualEntry, readCounterfactualLot, recordCounterfactualObservation } = await import('./paperCounterfactualStore')
  const f = l4NativeFixture()
  try {
    f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0012_counterfactual_recorder.sql', import.meta.url), 'utf8'))
    const before = f.sqls.paper.prepare('SELECT * FROM paper_accounts').all()
    const db = f.env.PAPER_DB
    const unobservable = await recordCounterfactualEntry(db, { ...entry(), lotId: 'missing-book', snapshot: null })
    assert.equal(unobservable.stored, null)
    assert.equal(f.sqls.paper.prepare('SELECT reason FROM paper_counterfactual_signals_v1 WHERE lot_id=?').get('missing-book')?.reason, 'execution_book_missing')
    const first = (await recordCounterfactualEntry(db, entry())).stored!
    assert.deepEqual((await recordCounterfactualEntry(db, entry())).stored, first)
    assert.equal(await readCounterfactualLot(db, 2, first.lot.lotId), null)
    const observation1 = { ...observation(), z: -1, snapshot: null }
    const update = await recordCounterfactualObservation(db, first, observation1)
    assert.deepEqual((await recordCounterfactualObservation(db, first, observation1)).stored, update.stored)
    await assert.rejects(recordCounterfactualObservation(db, first, { ...observation(), z: 2 }), /state_conflict/)
    const restored = (await readCounterfactualLot(db, 1, first.lot.lotId))!
    const ms = Date.parse(next + 'T09:05:00+08:00')
    const closed = await recordCounterfactualObservation(db, restored, { ...observation(ms), date: next, z: 2 })
    assert.equal(closed.lot.arms.z_hysteresis.shares, 0)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) AS n FROM paper_counterfactual_events_v1').get()?.n, 3)
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_accounts').all(), before)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) AS n FROM paper_orders').get()?.n, 0)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) AS n FROM paper_positions').get()?.n, 0)
    f.sqls.paper.prepare('UPDATE paper_counterfactual_lots_v1 SET state_json=? WHERE lot_id=?').run('{}', first.lot.lotId)
    await assert.rejects(readCounterfactualLot(db, 1, first.lot.lotId), /checksum_mismatch/)
  } finally { f.close() }
})


test('odd and board lot books cannot substitute for one another', () => {
  assert.equal(openCounterfactualLot({ ...entry(), requestedShares: 1000 }).reason, 'execution_lot_type_mismatch')
  assert.throws(() => openCounterfactualLot({ ...entry(), requestedShares: 1500 }), /requested_lot_invalid/)
})

test('unfilled expiry respects closing auction and resumes next session', () => {
  const lot = openCounterfactualLot(entry()).lot!
  const calendar = Array.from({ length: 40 }, (_, i) => new Date(Date.parse(date + 'T00:00:00Z') + i * 86400_000))
    .filter(d => ![0, 6].includes(d.getUTCDay())).map(d => d.toISOString().slice(0, 10))
  const expiry = calendar[20], nextSession = calendar[21]
  const ms = Date.parse(expiry + 'T13:24:00+08:00')
  const first = advanceCounterfactualLot(lot, { ...observation(ms), date: expiry, calendar, snapshot: null })
  assert.ok(first.events.every(e => e.status === 'unobservable'))
  const after = ms + 2 * 60_000
  const auction = advanceCounterfactualLot(first.lot, { ...observation(after), date: expiry, calendar })
  assert.ok(auction.events.every(e => e.status === 'hold' && e.reason === 'swing_expiry_outside_continuous_session'))
  const resumed = Date.parse(nextSession + 'T09:05:00+08:00')
  const done = advanceCounterfactualLot(auction.lot, { ...observation(resumed), date: nextSession, calendar })
  assert.ok(done.events.every(e => e.status === 'closed'))
})
