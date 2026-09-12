import assert from 'node:assert/strict'
import test from 'node:test'
import { runDailySnapshot } from './paperWorkerTasks'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Bindings } from '../types'
import { withPaperExecutionScope, recordPaperExecutionFailure, paperExecutionDate } from './paperExecutionScope'
import { runNativePaperExecutionFrame } from './nativePaperExecutionFrame'
import { executeRescoreSell } from './paperWorkerTasks'
import { buildChampionTradingConfig } from './tradingConfig'

class Statement {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args) }
  private execute(kind: 'all' | 'get' | 'run') {
    try {
      const clock = paperExecutionDate().toISOString()
      const sql = this.sql.replace(/\bCURRENT_TIMESTAMP\b/gi, `'${clock}'`)
        .replace(/\b(datetime|date|time)\(\s*'now'/gi, `$1('${clock}'`)
      return this.db.prepare(sql)[kind](...this.args)
    } catch (error) { recordPaperExecutionFailure('sqlite_failed'); throw error }
  }
  async first(column?: string) { const row = this.execute('get') as any; return column ? row?.[column] ?? null : row ?? null }
  async all() { return { results: this.execute('all'), success: true } }
  async run() { const r = this.execute('run') as any; return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } } }
}

function fixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(fs.readFileSync('domain-migrations/ops/0005_ops_artifact_compute_cost_runtime.sql', 'utf8'))
  sql.exec(`
    CREATE TABLE paper_accounts(id INTEGER PRIMARY KEY,cash REAL,initial_cash REAL);
    INSERT INTO paper_accounts VALUES(1,999999,999999),(2,90000,100000);
    CREATE TABLE paper_positions(account_id INTEGER,symbol TEXT,shares REAL,name TEXT,entry_price REAL,entry_date TEXT,avg_cost REAL,PRIMARY KEY(account_id,symbol));
    INSERT INTO paper_positions VALUES(1,'2330',777,'sentinel',1,'2026-09-01',1),(2,'2330',100,'TSMC',100,'2026-09-01',100);
    CREATE TABLE paper_orders(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER,symbol TEXT,name TEXT,side TEXT,shares REAL,price REAL,commission REAL,tax REAL,total_cost REAL,source TEXT,signal TEXT,confidence REAL,note TEXT,created_at TEXT DEFAULT '2026-09-07T02:00:00Z');
    CREATE TABLE paper_settlements(id INTEGER PRIMARY KEY,account_id INTEGER,order_id INTEGER,symbol TEXT,side TEXT,amount REAL,trade_date TEXT,settlement_date TEXT,settled INTEGER DEFAULT 0);
    CREATE TABLE paper_execution_events(id INTEGER PRIMARY KEY,account_id INTEGER,trade_date TEXT,symbol TEXT,side TEXT,event_type TEXT,status TEXT,reason TEXT,detail_json TEXT,order_id INTEGER,pending_run_id INTEGER,source TEXT,created_at TEXT);
    CREATE TABLE paper_daily_snapshots(account_id INTEGER,date TEXT,cash REAL,positions_value REAL,total_value REAL,pnl REAL,pnl_pct REAL,benchmark_value REAL,twii_value REAL,max_drawdown_to_date REAL,sharpe_30d REAL,sortino_30d REAL,calmar REAL,cagr REAL,created_at TEXT,PRIMARY KEY(account_id,date));
    CREATE TABLE stocks(id INTEGER PRIMARY KEY,symbol TEXT);
    INSERT INTO stocks VALUES(1,'2330'),(2,'0050');
    CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,close REAL);
    INSERT INTO stock_prices VALUES(1,'2026-09-07',110),(2,'2026-09-07',200);
    CREATE TABLE market_risk(date TEXT,twii_close REAL);
    INSERT INTO market_risk VALUES('2026-09-07',22000);
    CREATE TABLE broker_execution_intents(trade_date TEXT);
    CREATE TABLE broker_execution_events(event_time TEXT,received_at TEXT);
    CREATE TABLE system_logs(level TEXT,cron_name TEXT,message TEXT,meta TEXT,created_at TEXT);
  `)
  sql.exec(fs.readFileSync('domain-migrations/paper/0004_corporate_action_accounting.sql', 'utf8'))
  const db = { prepare: (s: string) => new Statement(sql, s), batch: async (statements: Statement[]) => {
    sql.exec('SAVEPOINT native_batch')
    try { const rows = []; for (const s of statements) rows.push(await s.run()); sql.exec('RELEASE native_batch'); return rows }
    catch (error) { sql.exec('ROLLBACK TO native_batch; RELEASE native_batch'); throw error }
  } } as unknown as D1Database
  const kvData = new Map([['trading:config', JSON.stringify(buildChampionTradingConfig(null))]])
  const kv = { get: async (key: string, type?: string) => {
    const value = kvData.get(key) ?? null; return type === 'json' && value != null ? JSON.parse(value) : value
  }, put: async (key: string, value: string) => { kvData.set(key, value) } } as unknown as KVNamespace
  const objects = new Map<string, string>()
  const artifacts = { put: async (key: string, text: string) => { objects.set(key, text) },
    get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null }
  const environment = { DB: db, PAPER_DB: db, EXECUTION_DB: db, KV: kv, ARTIFACTS: artifacts } as unknown as Bindings
  const ports = { environment, accountId: 2, nowMs: Date.parse('2026-09-07T06:00:00Z'),
    databases: { core: db, paper: db, market: db, execution: db, ops: db },
    fetchFrozen: async (input: RequestInfo | URL) => {
      assert.match(String(input), /^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/2330\.TW/)
      return new Response('', { status: 503 }) // captured outage; native canonical-close fallback must run
    },
    transaction: async <T>(execute: () => Promise<T>): Promise<T> => {
      const priorKv = new Map(kvData), priorObjects = new Map(objects)
      sql.exec('BEGIN')
      try { const value = await execute(); sql.exec('COMMIT'); return value }
      catch (error) {
        sql.exec('ROLLBACK'); kvData.clear(); objects.clear()
        priorKv.forEach((v, k) => kvData.set(k, v)); priorObjects.forEach((v, k) => objects.set(k, v))
        throw error
      }
    } }
  return { sql, ports, objects }
}

test('actual native snapshot values injected account, persists native artifact checksums and leaves sentinel untouched', async () => {
  const f = fixture()
  await runNativePaperExecutionFrame(f.ports, 'snapshot')
  const snap = f.sql.prepare('SELECT * FROM paper_daily_snapshots WHERE account_id=2').get() as any
  assert.equal(snap.total_value, 101000)
  assert.equal(snap.positions_value, 11000)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_daily_snapshots WHERE account_id=1').get()?.n, 0)
  assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=1').get()?.shares, 777)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM run_artifacts WHERE status=\'ready\' AND checksum_verified_at IS NOT NULL').get()?.n, 2)
  assert.equal(f.objects.size, 2)
  f.sql.close()
})

test('native partial rescore exit retains shares, charges real fees and records only the isolated account', async () => {
  const f = fixture()
  const args = { symbol: '2330', shares: 40, price: 110, reason: 'native_test', source: 'rescore',
    quote: { last: 110, bid: 110, ask: 110.5, low: 109, high: 112 } as any }
  const result = await withPaperExecutionScope(f.ports, () => executeRescoreSell(f.ports.environment, args))
  assert.equal(result.result.filled, true)
  assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=2').get()?.shares, 60)
  assert.equal(f.sql.prepare('SELECT shares FROM paper_positions WHERE account_id=1').get()?.shares, 777)
  const order = f.sql.prepare('SELECT * FROM paper_orders').get() as any
  assert.equal(order.account_id, 2)
  assert.ok(order.commission > 0 && order.tax > 0)
  assert.equal(order.total_cost, order.price * 40 - order.commission - order.tax)
  assert.equal(f.sql.prepare('SELECT amount FROM paper_settlements WHERE account_id=2').get()?.amount, order.total_cost)
  assert.equal(f.sql.prepare('SELECT account_id FROM paper_execution_events').get()?.account_id, 2)
  await assert.rejects(withPaperExecutionScope(f.ports, () => executeRescoreSell(f.ports.environment, { ...args, shares: 100 })), /position_or_quantity_invalid/)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_orders').get()?.n, 1)
  f.sql.close()
})

test('missing mark or missing account cannot produce a successful native daily snapshot', async () => {
  const f = fixture()
  f.sql.exec('DELETE FROM stock_prices WHERE stock_id=1')
  await assert.rejects(runNativePaperExecutionFrame(f.ports, 'snapshot'), /held_marks_missing/)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_daily_snapshots').get()?.n, 0)
  await assert.rejects(runNativePaperExecutionFrame({ ...f.ports, accountId: 99 }, 'snapshot'), /account_missing/)
  f.sql.close()
})

test('formal snapshot durably records unknown rights without fictitious NAV or closure', async () => {
  const f = fixture()
  const rights = { ratio: .1, issued_ratio: .2, subscription_price: 83,
    policy: 'do_not_subscribe', payment_start: '2026-09-07', payment_deadline: '2026-09-09',
    expiry_policy: 'unexercised_original_holder_rights_expire', fractional_policy: 'retain_no_automatic_pooling',
    fair_value_per_right: null, valuation_status: 'unobservable', promotion_eligible: false,
    evidence_checksums: ['b'.repeat(64)], quantity: 10, whole_quantity: 10 }
  f.sql.prepare(`INSERT INTO paper_corporate_entitlements_v1
    (account_id,action_id,symbol,kind,ex_date,eligible_shares,rights_json,terms_json,source_checksum,recognized_at)
    VALUES(2,'right','2330','subscription','2026-09-07',100,?,'{}',?,'2026-09-07T00:00:00Z')`)
    .run(JSON.stringify(rights), 'a'.repeat(64))
  await assert.rejects(withPaperExecutionScope(f.ports,
    () => runDailySnapshot(f.ports.environment)), /fair_value_unobservable/)
  const audit = f.sql.prepare("SELECT * FROM paper_execution_events WHERE status='pending_valuation'").get() as any
  assert.equal(audit.account_id, 2)
  const pointer = JSON.parse(audit.detail_json).evidence_pointer
  const evidence = JSON.parse(f.objects.get(pointer.r2_key)!)
  const detail = evidence.detail ?? evidence.payload?.detail
  assert.equal(detail.nav, null)
  assert.equal(detail.nav_lower_bound, 101000)
  assert.equal(detail.nav_upper_bound, 102100)
  assert.deepEqual(detail.unpriced_rights, ['right'])
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM paper_daily_snapshots').get()?.n, 0)
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM run_artifacts WHERE domain IN ('execution_daily_closure','paper_daily_closure')").get()?.n, 0)
  assert.equal(f.sql.prepare('SELECT cash FROM paper_accounts WHERE id=2').get()?.cash, 90000)
  f.sql.close()
})

test('native helpers catching a missing sealed response cannot commit any SQL or artifact side effects', async () => {
  const f = fixture()
  await assert.rejects(runNativePaperExecutionFrame({ ...f.ports,
    fetchFrozen: async () => { throw new Error('not_in_frozen_input') } }, 'snapshot'), /scope_incomplete/)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_daily_snapshots').get()?.n, 0)
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM run_artifacts').get()?.n, 0)
  assert.equal(f.objects.size, 0)
  // Identical account retries successfully once the missing observation is supplied.
  await runNativePaperExecutionFrame(f.ports, 'snapshot')
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM paper_daily_snapshots').get()?.n, 1)
  f.sql.close()
})
