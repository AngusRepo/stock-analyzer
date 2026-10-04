import assert from 'node:assert/strict'
import test from 'node:test'
import { executeContinuousPaperBatch, isPaperContinuousSession } from './paperContinuousExecution'
import { executePaperSellBatch } from './paperSellTransaction'
import { advancePaperExecutionClock, withPaperExecutionScope } from './paperExecutionScope'
import { l4NativeFixture } from './l4NativeFixture.testSupport'

const at = (clock: string) => Date.parse(`2026-10-02T${clock}+08:00`)

test('execution excludes closing auction, delayed close and post-close; observation clock is unchanged', () => {
  assert.equal(isPaperContinuousSession(at('13:24:59.999')), true)
  for (const clock of ['08:59:59.999', '13:25:00', '13:29:59', '13:30:00', '13:33:00', '14:00:00'])
    assert.equal(isPaperContinuousSession(at(clock)), false, clock)
  assert.equal(isPaperContinuousSession(NaN), false)
  assert.equal(isPaperContinuousSession(Date.parse('2026-10-03T10:00:00+08:00')), false)
})

for (const side of ['buy', 'sell']) test(`auction rejects ${side} batch without mutating positions, cash or orders`, async () => {
  const f = l4NativeFixture()
  f.ports.nowMs = at('13:25:00')
  try {
    const before = f.sqls.paper.prepare('SELECT cash FROM paper_accounts WHERE id=1').get()
    await withPaperExecutionScope(f.ports, async () => {
      await assert.rejects(executeContinuousPaperBatch(f.env, [
        f.env.PAPER_DB.prepare('UPDATE paper_accounts SET cash=cash+100 WHERE id=1'),
        f.env.PAPER_DB.prepare(`INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,source)
          VALUES(1,'2340',?,1000,100,100000,'test')`).bind(side),
      ]), /paper_outside_continuous_session/)
    })
    assert.deepEqual(f.sqls.paper.prepare('SELECT cash FROM paper_accounts WHERE id=1').get(), before)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_orders').get()?.n, 0)
  } finally { f.close() }
})

test('any sell crossing cutoff during settlement lookup is blocked without an optional expiry deadline', async () => {
  const f = l4NativeFixture(), cutoff = at('13:25:00')
  f.ports.nowMs = cutoff - 1
  const original = f.env.KV.get.bind(f.env.KV)
  f.env.KV.get = async (...args: any[]) => { advancePaperExecutionClock(cutoff); return original(...args) }
  try {
    await withPaperExecutionScope(f.ports, async () => {
      await assert.rejects(executePaperSellBatch(f.env, [
        f.env.PAPER_DB.prepare('UPDATE paper_accounts SET cash=cash+100 WHERE id=1'),
        f.env.PAPER_DB.prepare('UPDATE paper_accounts SET cash=cash+100 WHERE id=1'),
      ], '2340', 100), /paper_outside_continuous_session/)
      assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_settlements').get()?.n, 0)
    })
  } finally { f.close() }
})

test('late next-bar buy cannot fill after its one-minute deadline', async () => {
  const f = l4NativeFixture()
  f.ports.nowMs = at('13:21:00')
  try {
    await withPaperExecutionScope(f.ports, async () => {
      await assert.rejects(executeContinuousPaperBatch(f.env, [
        f.env.PAPER_DB.prepare('UPDATE paper_accounts SET cash=cash-100 WHERE id=1'),
      ], at('13:21:00')), /paper_submission_window_expired/)
    })
  } finally { f.close() }
})
