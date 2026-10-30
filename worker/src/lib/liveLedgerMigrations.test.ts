import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tableOwnershipMetadata, tablesForDataDomainRouteReady } from './dataDomainRegistry'

const LIVE_TABLES = [
  'live_submission_control_v1',
  'live_account_observations_v1',
  'live_daily_snapshots_v1',
  'live_cash_flows_v1',
  'live_intake_orders_v1',
  'live_intake_alert_state_v1',
]
const ZERO = '0'.repeat(64)

function migrated(): DatabaseSync {
  const dir = path.join('domain-migrations', 'execution')
  const db = new DatabaseSync(':memory:')
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), 'utf8'))
  }
  return db
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
}

function rowHash(row: Record<string, unknown>): string {
  const { row_sha256: _ignored, ...rest } = row
  return createHash('sha256').update(canonical(rest)).digest('hex')
}

function throwsSql(db: DatabaseSync, sql: string, params: unknown[], message: RegExp): void {
  assert.throws(() => db.prepare(sql).run(...(params as never[])), message)
}

// Ownership: the Live ledger is execution-owned and never shared with Paper.
for (const table of LIVE_TABLES) {
  const owner = tableOwnershipMetadata(table)
  assert.equal(owner?.domain, 'execution', `${table} must be execution-owned`)
  assert.equal(owner?.route_ready, false, `${table} stays off the route-ready set until the migrations are applied`)
  assert(!tablesForDataDomainRouteReady('paper').includes(table))
}
for (const file of fs.readdirSync(path.join('domain-migrations', 'paper'))) {
  const sql = fs.readFileSync(path.join('domain-migrations', 'paper', file), 'utf8')
  for (const table of LIVE_TABLES) assert(!sql.includes(table), `paper migration ${file} must not touch ${table}`)
}

// R17: Live starts paused, through a verifiable seed row.
{
  const db = migrated()
  const rows = db.prepare('SELECT * FROM live_submission_control_v1 ORDER BY sequence').all() as Record<string, unknown>[]
  assert.equal(rows.length, 1)
  const seed = { ...rows[0] }
  assert.equal(seed.action, 'pause')
  assert.equal(seed.request_id, 'initial_seed')
  assert.equal(seed.previous_sha256, ZERO)
  assert.equal(seed.row_sha256, rowHash(seed), 'seed row hash must cover every other column')

  // Re-applying the migration is idempotent and never resumes Live.
  db.exec(fs.readFileSync(path.join('domain-migrations', 'execution', '0005_live_submission_control.sql'), 'utf8'))
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM live_submission_control_v1').get() as { n: number }).n, 1)

  const insert = 'INSERT INTO live_submission_control_v1 (sequence,action,request_id,actor,reason,approval_scope,'
    + 'approval_expires_at,gate_receipt_sha256,created_at,previous_sha256,row_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  const resume = [2, 'resume', 'r-1', 'wei', 'gate passed', 'scope-a', '2026-12-31T05:30:00+00:00', 'a'.repeat(64),
    '2026-12-09T08:00:00+00:00', String(seed.row_sha256), 'b'.repeat(64)]
  // A resume without scope/expiry/receipt is rejected by the schema.
  throwsSql(db, insert, [2, 'resume', 'r-0', 'wei', 'x', null, null, null, 'now', String(seed.row_sha256), 'c'.repeat(64)], /CHECK/)
  throwsSql(db, insert, [2, 'resume', 'r-0', 'wei', 'x', 'scope', 'later', 'short', 'now', String(seed.row_sha256), 'c'.repeat(64)], /CHECK/)
  // A pause may not smuggle approval fields.
  throwsSql(db, insert, [2, 'pause', 'p-0', 'admin', 'x', 'scope', null, null, 'now', String(seed.row_sha256), 'c'.repeat(64)], /CHECK/)
  // Chain: wrong predecessor, skipped or repeated sequence.
  throwsSql(db, insert, resume.map((v, i) => (i === 9 ? ZERO : v)), /chain_conflict/)
  throwsSql(db, insert, resume.map((v, i) => (i === 0 ? 3 : v)), /chain_conflict/)
  db.prepare(insert).run(...(resume as never[]))
  throwsSql(db, insert, [2, 'pause', 'p-1', 'admin', 'x', null, null, null, 'now', 'b'.repeat(64), 'd'.repeat(64)], /chain_conflict|UNIQUE/)
  throwsSql(db, insert, [3, 'pause', 'r-1', 'admin', 'x', null, null, null, 'now', 'b'.repeat(64), 'd'.repeat(64)], /UNIQUE/)
  // History is immutable.
  throwsSql(db, "UPDATE live_submission_control_v1 SET action='pause' WHERE sequence=2", [], /immutable/)
  throwsSql(db, 'DELETE FROM live_submission_control_v1 WHERE sequence=1', [], /immutable/)
}

// R18: account observations cannot be rewritten.
{
  const db = migrated()
  const insert = 'INSERT INTO live_account_observations_v1 (account_scope,request_id,observed_at,sha256,payload_json) VALUES (?,?,?,?,?)'
  throwsSql(db, insert, ['paper:1', 'q', 't', 's', '{}'], /CHECK/)
  db.prepare(insert).run('live:sinopac:x', 'q', 't', 's', '{}')
  db.prepare(insert.replace('INSERT', 'INSERT OR IGNORE')).run('live:sinopac:x', 'q', 't', 's', '{}')
  throwsSql(db, insert, ['live:sinopac:x', 'q', 't', 's2', '{}'], /conflict|UNIQUE/)
  throwsSql(db, "UPDATE live_account_observations_v1 SET sha256='z'", [], /immutable/)
  throwsSql(db, 'DELETE FROM live_account_observations_v1', [], /immutable/)
}

// NEW-H1g: flows carry a sign that matches their kind; ledger rows are immutable.
{
  const db = migrated()
  const flow = 'INSERT INTO live_cash_flows_v1 (flow_id,account_scope,flow_date,kind,amount,source,evidence_sha256,recorded_at) VALUES (?,?,?,?,?,?,?,?)'
  const ev = 'e'.repeat(64)
  throwsSql(db, flow, ['f0', 'live:sinopac:x', '2026-12-09', 'deposit', -1, 'wei_manual', ev, 't'], /CHECK/)
  throwsSql(db, flow, ['f0', 'live:sinopac:x', '2026-12-09', 'withdrawal', 1, 'wei_manual', ev, 't'], /CHECK/)
  throwsSql(db, flow, ['f0', 'live:sinopac:x', '2026-12-09', 'deposit', 0, 'wei_manual', ev, 't'], /CHECK/)
  throwsSql(db, flow, ['f0', 'paper:1', '2026-12-09', 'deposit', 1, 'wei_manual', ev, 't'], /CHECK/)
  db.prepare(flow).run('f1', 'live:sinopac:x', '2026-12-09', 'deposit', 100000, 'wei_manual', ev, 't')
  throwsSql(db, 'UPDATE live_cash_flows_v1 SET amount=1', [], /immutable/)
  throwsSql(db, 'DELETE FROM live_cash_flows_v1', [], /immutable/)

  const snap = 'INSERT INTO live_daily_snapshots_v1 (account_scope,business_date,observation_sha256,cash,unsettled_net,'
    + 'positions_value,nav,net_external_flow,return_index,peak_return_index,drawdown,marks_json,payload_sha256,created_at) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  const day = '2026-12-09'
  throwsSql(db, snap, ['live:sinopac:x', day, ev, 1, 0, 0, 1, 0, 1, 0.9, 0, '{}', ev, 't'], /CHECK/)
  throwsSql(db, snap, ['live:sinopac:x', day, ev, 1, 0, 0, 1, 0, 1, 1, 0.1, '{}', ev, 't'], /CHECK/)
  // Dates are compared as text, so only YYYY-MM-DD is stored.
  throwsSql(db, snap, ['live:sinopac:x', '20261209', ev, 1, 0, 0, 1, 0, 1, 1, 0, '{}', ev, 't'], /CHECK/)
  throwsSql(db, flow, ['f9', 'live:sinopac:x', '20261209', 'deposit', 1, 'wei_manual', ev, 't'], /CHECK/)
  db.prepare(snap).run('live:sinopac:x', day, ev, 1, 0, 0, 1, 0, 0.95, 1, -0.05, '{}', ev, 't')
  throwsSql(db, 'UPDATE live_daily_snapshots_v1 SET nav=2', [], /immutable/)
  throwsSql(db, 'DELETE FROM live_daily_snapshots_v1', [], /immutable/)
}

// R21: the D-6 conversion is frozen once recorded; only processing status may advance.
{
  const db = migrated()
  const ins = 'INSERT INTO live_intake_orders_v1 (paper_order_ref,trade_date,symbol,side,paper_shares,live_shares,'
    + 'idempotency_key,conversion_json,conversion_sha256,status,status_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  const sha = 'c'.repeat(64)
  db.prepare(ins).run('paper_orders:1', '2026-12-10', '2330', 'buy', 1000, 37, null, '{}', sha, 'RECEIVED', null, 't', 't')
  throwsSql(db, "UPDATE live_intake_orders_v1 SET live_shares=38", [], /immutable/)
  throwsSql(db, "UPDATE live_intake_orders_v1 SET conversion_json='{\"x\":1}'", [], /immutable/)
  db.prepare("UPDATE live_intake_orders_v1 SET status='RELAYED', idempotency_key='live:k', updated_at='t2'").run()
  throwsSql(db, "UPDATE live_intake_orders_v1 SET status='UNKNOWN'", [], /immutable/)
  throwsSql(db, 'DELETE FROM live_intake_orders_v1', [], /immutable/)
  throwsSql(db, ins, ['paper_orders:2', 'd', 's', 'hold', 1, 0, null, '{}', sha, 'RECEIVED', null, 't', 't'], /CHECK/)
  throwsSql(db, ins, ['paper_orders:2', 'd', 's', 'buy', 1, -1, null, '{}', sha, 'RECEIVED', null, 't', 't'], /CHECK/)
  // UNKNOWN is reconcile-only: it never returns to a sendable status, except a sell the
  // gateway blocked before reserving (no broker order), which goes back to DEFERRED.
  db.prepare(ins).run('paper_orders:3', '2026-12-10', '2330', 'buy', 1000, 37, 'live:u', '{}', sha, 'UNKNOWN', null, 't', 't')
  for (const back of ['RECEIVED', 'DEFERRED', 'SKIPPED']) {
    throwsSql(db, `UPDATE live_intake_orders_v1 SET status='${back}' WHERE paper_order_ref='paper_orders:3'`, [], /immutable/)
  }
  db.prepare("UPDATE live_intake_orders_v1 SET status='BLOCKED', status_reason='reconciled_no_broker_order' WHERE paper_order_ref='paper_orders:3'").run()
  db.prepare(ins).run('paper_orders:4', '2026-12-10', '2330', 'sell', 1000, 37, 'live:s', '{}', sha, 'UNKNOWN', null, 't', 't')
  for (const back of ['RECEIVED', 'SKIPPED']) {
    throwsSql(db, `UPDATE live_intake_orders_v1 SET status='${back}' WHERE paper_order_ref='paper_orders:4'`, [], /immutable/)
  }
  db.prepare("UPDATE live_intake_orders_v1 SET status='DEFERRED', sent_on='2026-12-10' WHERE paper_order_ref='paper_orders:4'").run()
}

// Alert state (Wei 10/30): one row per alert, day and reason; a repeat is ignored.
{
  const db = migrated()
  const up = 'INSERT INTO live_intake_alert_state_v1 (alert,alert_day,reason,token,updated_at) VALUES (?,?,?,?,?) '
    + 'ON CONFLICT(alert,alert_day,reason) DO NOTHING'
  const token = (reason: string) => (db.prepare(
    'SELECT token FROM live_intake_alert_state_v1 WHERE alert=? AND alert_day=? AND reason=?').get('nav', '2026-12-10', reason) as { token: string }).token
  db.prepare(up).run('nav', '2026-12-10', 'r1', 't1', 'x')
  db.prepare(up).run('nav', '2026-12-10', 'r1', 't2', 'x')
  assert.equal(token('r1'), 't1')
  db.prepare(up).run('nav', '2026-12-10', 'r2', 't3', 'x')
  assert.equal(token('r2'), 't3')
  throwsSql(db, up, ['nav', '2026-12', 'r', 't', 'x'], /CHECK/)
}

// The generated domain schema carries the same Live tables.
{
  const schema = fs.readFileSync(path.join('domain-schemas', 'execution.sql'), 'utf8')
  for (const table of LIVE_TABLES) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
}
console.log('live ledger migration contract passed')
