import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Bindings } from '../types'
import { writeAuditEntry } from './riskAudit'
import { withPaperExecutionScope } from './paperExecutionScope'

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE risk_audit_log(
    trigger_event TEXT,account_id INTEGER,symbol TEXT,side TEXT,decision TEXT,halt INTEGER,
    triggered_count INTEGER,severity TEXT,max_position_pct REAL,buy_conf_threshold REAL,
    sell_conf_threshold REAL,risk_state_json TEXT,order_validation_json TEXT,config_version TEXT)`)
  const db = { prepare(sql: string) { return { bind(...values: unknown[]) {
    return { async run() { sqlite.prepare(sql).run(...values as any[]); return { success: true } } }
  } } } } as D1Database
  const environment = { DB: db, KV: {} } as Bindings
  return { sqlite, db, environment }
}

const riskState = { halt: false, maxPositionPct: .12, buyConfThreshold: .6, sellConfThreshold: .4 }

test('risk audit follows the same account as overlapping native execution scopes', async () => {
  const f = fixture()
  try {
    await Promise.all([2, 7].map(accountId => withPaperExecutionScope({
      accountId, environment: f.environment, databases: { paper: f.db },
      nowMs: Date.parse('2026-10-20T01:00:00Z'),
      fetchFrozen: async () => { throw new Error('unexpected_network') },
    }, async () => {
      await new Promise(resolve => setTimeout(resolve, accountId === 2 ? 5 : 1))
      await writeAuditEntry(f.db, { triggerEvent: 'intraday_buy', symbol: '2330',
        decision: 'deferred', riskState, configVersion: 'account-' + accountId })
    })))
    const rows = f.sqlite.prepare('SELECT account_id,config_version,risk_state_json FROM risk_audit_log ORDER BY account_id').all()
    assert.deepEqual(rows.map(row => row.account_id), [2, 7])
    assert.deepEqual(rows.map(row => row.config_version), ['account-2', 'account-7'])
    assert.ok(rows.every(row => JSON.stringify(JSON.parse(String(row.risk_state_json))) === JSON.stringify(riskState)))
  } finally { f.sqlite.close() }
})

test('unscoped risk audit retains the existing Paper account', async () => {
  const f = fixture()
  try {
    await writeAuditEntry(f.db, { triggerEvent: 'morning_setup', decision: 'deferred', riskState })
    assert.equal(f.sqlite.prepare('SELECT account_id FROM risk_audit_log').get()!.account_id, 1)
  } finally { f.sqlite.close() }
})

test('audit storage failure remains non-fatal', async () => {
  const db = { prepare() { throw new Error('unavailable_audit_store') } } as unknown as D1Database
  await assert.doesNotReject(writeAuditEntry(db, { triggerEvent: 'intraday_buy', decision: 'deferred', riskState }))
})
