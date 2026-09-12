import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Bindings } from '../types'
import { withPaperExecutionScope, paperAccountId, paperExecutionNow, paperExecutionFetch } from './paperExecutionScope'
import { databaseForDataDomain } from './dataDomainRegistry'
import { getTwClockParts } from './twMarketSession'
import { sendDiscordNotification } from './notify'
import { buildPaperBuyIntentKey } from './paperOrderIntent'
import { checkP5Losses } from './riskChecks/p5Losses'
import { getTradingConfig, invalidateConfigCache } from './tradingConfig'
import { normalizePaperExecutionEvent } from './paperExecutionEvents'
import { runIntradayCheck } from './paperEntryTasks'

const defaults = { halt: false, maxPositionPct: .3, buyConfThreshold: .6, sellConfThreshold: .4 }
const at = Date.parse('2026-09-07T02:00:00Z')

function ports(id = 2, nowMs = at) {
  const db = {} as D1Database
  const environment = { DB: db, KV: {} } as Bindings
  return { accountId: id, nowMs, environment, databases: { paper: db, core: db, ops: db },
    fetchFrozen: async () => new Response('sealed') }
}

test('overlapping native calls retain separate accounts, clocks, databases and notifications', async () => {
  const jobs = [ports(2, at), ports(3, at + 3_600_000)].map(p => withPaperExecutionScope(p, async () => {
    await new Promise(resolve => setTimeout(resolve, p.accountId === 2 ? 10 : 1))
    assert.equal(paperAccountId(), p.accountId)
    assert.equal(paperExecutionNow(), p.nowMs)
    assert.equal(getTwClockParts().hour, p.accountId === 2 ? 10 : 11)
    assert.equal(databaseForDataDomain(p.environment, 'paper'), p.databases.paper)
    assert.equal(buildPaperBuyIntentKey('2026-09-07', '2330'), `${p.accountId}:2026-09-07:2330:buy:auto_ml`)
    assert.equal(normalizePaperExecutionEvent({ eventType: 'paper_order', status: 'filled' }).accountId, p.accountId)
    await sendDiscordNotification('https://must-not-send.invalid', 'isolated:' + p.accountId)
    return p.accountId
  }))
  const results = await Promise.all(jobs)
  assert.deepEqual(results.map(r => r.result), [2, 3])
  assert.deepEqual(results.map(r => r.notifications[0].message), ['isolated:2', 'isolated:3'])
  assert.equal(paperAccountId(), 1)
  assert.ok(Math.abs(paperExecutionNow() - Date.now()) < 1000)
})

test('caught foreign database or missing frozen transport still invalidates the whole step', async () => {
  const p = ports()
  await assert.rejects(withPaperExecutionScope(p, async () => {
    try { databaseForDataDomain({ DB: {} } as Bindings, 'paper') } catch { /* native catch cannot hide it */ }
  }), /scope_incomplete:unscoped_database/)
  await assert.rejects(withPaperExecutionScope({ ...p, fetchFrozen: async () => { throw new Error('missing') } }, async () => {
    try { await paperExecutionFetch('https://sealed.invalid') } catch { /* deliberately swallowed */ }
  }), /scope_incomplete:frozen_transport_failed/)
  assert.equal(paperAccountId(), 1)
})

test('exception restores formal context, nesting is forbidden, native closed-session route uses scoped clock', async () => {
  const p = ports(9, Date.parse('2026-09-06T02:00:00Z')) // Sunday
  await assert.rejects(withPaperExecutionScope(p, async () => { throw new Error('native_failure') }), /native_failure/)
  await assert.rejects(withPaperExecutionScope(p, () => withPaperExecutionScope(p, async () => null)), /nested_scope/)
  const result = await withPaperExecutionScope(p, () => runIntradayCheck(p.environment))
  assert.equal(result.result.status, 'healthy_empty')
  assert.equal(paperAccountId(), 1)
})

test('actual P5 losing trades halt cannot be overwritten by defaults and selects only injected account', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE paper_orders(id INTEGER PRIMARY KEY,account_id INTEGER,side TEXT,price REAL,shares REAL,commission REAL,tax REAL,note TEXT)')
  for (let i = 0; i < 3; i++) sqlite.prepare('INSERT INTO paper_orders(account_id,side,price,shares,commission,tax,note) VALUES(2,\'sell\',90,100,20,27,?)')
    .run(JSON.stringify({ entry_price: 100 }))
  const db = { prepare(sql: string) { return { bind(...args: any[]) { return { async all() { return { results: sqlite.prepare(sql).all(...args) } } } } } } } as D1Database
  const p = ports()
  const result = await withPaperExecutionScope(p, () => checkP5Losses(db, { defaults, effectiveBuy: .6, effectiveSell: .4 }))
  assert.equal(result.result?.halt, true)
  assert.equal(result.result?.maxPositionPct, 0)
  assert.match(result.result?.reason ?? '', /3.*3/)
  assert.equal(await checkP5Losses(db, { defaults, effectiveBuy: .6, effectiveSell: .4 }), null)
  sqlite.close()
})

test('native trading config cache is bound to KV instance, not whichever request ran first', async () => {
  invalidateConfigCache()
  const kv = (score: number) => ({ get: async () => ({ signal: { buySignalScore: score } }) }) as unknown as KVNamespace
  const a = kv(.51), b = kv(.81)
  assert.equal((await getTradingConfig(a)).signal.buySignalScore, .51)
  assert.equal((await getTradingConfig(b)).signal.buySignalScore, .81)
  assert.equal((await getTradingConfig(a)).signal.buySignalScore, .51)
})
