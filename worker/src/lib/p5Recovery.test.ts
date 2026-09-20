import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { previewP5Recovery, applyP5Recovery } from './p5Recovery'
import { checkP5Losses } from './riskChecks/p5Losses'
import { checkP1Mdd } from './riskChecks/p1Mdd'
import { checkP8DailyPnl } from './riskChecks/p8DailyPnl'
import { checkS1KillSwitch } from './riskChecks/s1KillSwitch'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { adminConfigCoreRoutes } from '../routes/adminConfigCoreRoutes'
import { withPaperExecutionScope } from './paperExecutionScope'

const deps = { defaults: { halt: false, maxPositionPct: .3, buyConfThreshold: .6, sellConfThreshold: .4 }, effectiveBuy: .6, effectiveSell: .4 }
function sell(f: ReturnType<typeof l4NativeFixture>, account = 1, pnl = -100) {
  f.sqls.paper.prepare(`INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,note,created_at)
    VALUES(?,'2330','sell',100,90,9000,?,'2026-07-17')`).run(account, JSON.stringify({ realized_pnl: pnl }))
}
async function request(f: ReturnType<typeof l4NativeFixture>) {
  return { ...await previewP5Recovery(f.env.PAPER_DB, 1), request_id: 'incident-july-rearm',
    incident_ref: 'incident/july', repair_version: 'test-repaired-version', validation_ref: 'audits/repair.json',
    validation_sha256: 'a'.repeat(64), approved_by: 'test-operator' }
}

test('old losses persist indefinitely; explicit re-arm preserves account history; three new losses halt again', async () => {
  const f = l4NativeFixture()
  try {
    for (let i=0;i<3;i++) sell(f)
    const orders = f.sqls.paper.prepare('SELECT * FROM paper_orders').all()
    const accounts = f.sqls.paper.prepare('SELECT * FROM paper_accounts').all()
    assert.equal((await checkP5Losses(f.env.PAPER_DB, deps))?.halt, true)
    const body = await request(f)
    assert.equal((await applyP5Recovery(f.env.PAPER_DB, 1, body)).written, true)
    assert.equal(await checkP5Losses(f.env.PAPER_DB, deps), null)
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_orders').all(), orders)
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_accounts').all(), accounts)
    assert.equal((await applyP5Recovery(f.env.PAPER_DB, 1, body)).written, false)
    await assert.rejects(applyP5Recovery(f.env.PAPER_DB, 1, { ...body, repair_version: 'different' }), /request_id_conflict/)
    assert.throws(() => f.sqls.paper.exec('DELETE FROM paper_p5_rearms_v1'), /append_only/)
    assert.throws(() => f.sqls.paper.exec("UPDATE paper_p5_rearms_v1 SET approved_by='changed'"), /append_only/)
    sell(f); sell(f)
    assert.equal(await checkP5Losses(f.env.PAPER_DB, deps), null)
    sell(f)
    assert.equal((await checkP5Losses(f.env.PAPER_DB, deps))?.halt, true)
    // Retrying a completed old approval cannot forgive subsequent losses.
    assert.equal((await applyP5Recovery(f.env.PAPER_DB, 1, body)).written, false)
    assert.equal((await checkP5Losses(f.env.PAPER_DB, deps))?.halt, true)
  } finally { f.close() }
})

test('rejects missing repair evidence and stale previews; atomic INSERT catches an intervening sell', async () => {
  const f = l4NativeFixture()
  try {
    for (let i=0;i<3;i++) sell(f)
    const body = await request(f)
    await assert.rejects(applyP5Recovery(f.env.PAPER_DB, 1, { ...body, validation_ref: '' }), /invalid_evidence/)
    sell(f)
    await assert.rejects(applyP5Recovery(f.env.PAPER_DB, 1, body), /stale_preview/)
    const fresh = await request(f)
    const base = f.env.PAPER_DB
    const racing = { prepare(sql: string) {
      const stmt = base.prepare(sql)
      if (!sql.startsWith('INSERT INTO paper_p5_rearms_v1')) return stmt
      return { bind(...args: any[]) { return { run: async () => { sell(f); return stmt.bind(...args).run() } } } }
    } } as D1Database
    await assert.rejects(applyP5Recovery(racing, 1, fresh), /stale_preview/)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) AS n FROM paper_p5_rearms_v1').get()?.n, 0)
    assert.equal((await checkP5Losses(base, deps))?.halt, true)
  } finally { f.close() }
})

test('account isolation and all other loss/kill-switch controls survive P5 re-arm', async () => {
  const f = l4NativeFixture()
  try {
    f.sqls.paper.exec('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(2,1000000,1000000)')
    for (let i=0;i<3;i++) { sell(f,1); sell(f,2) }
    await applyP5Recovery(f.env.PAPER_DB, 1, await request(f))
    assert.equal(await checkP5Losses(f.env.PAPER_DB, deps), null)
    const other = await withPaperExecutionScope({ ...f.ports, accountId: 2 }, () => checkP5Losses(f.env.PAPER_DB, deps))
    assert.equal(other.result?.halt, true)
    for (const [date,nav] of [['2026-09-01',1000000],['2026-09-02',900000],['2026-09-03',500000]]) {
      f.sqls.paper.prepare('INSERT INTO paper_daily_snapshots(account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(1,?,?,0,?,0,0)').run(date,nav,nav)
    }
    assert.equal((await checkP1Mdd(f.env.PAPER_DB, f.cfg, deps))?.halt, true)
    assert.equal((await checkP8DailyPnl(f.env.PAPER_DB, DEFAULT_RISK_CONFIG, deps))?.halt, true)
    f.kvs.set('trading:risk_config', JSON.stringify({ ...DEFAULT_RISK_CONFIG, system: { ...DEFAULT_RISK_CONFIG.system, killSwitch: true } }))
    assert.equal((await checkS1KillSwitch(f.env.KV, deps))?.halt, true)
  } finally { f.close() }
})

test('admin route requires service authentication, defaults to preview, and requires explicit apply confirmation', async () => {
  const f = l4NativeFixture()
  try {
    f.env.STOCKVISION_AUTH_TOKEN = 'test-service-token'
    for (let i=0;i<3;i++) sell(f)
    const url='/api/admin/risk-config/p5-rearm'
    const headers={ Authorization: 'Bearer test-service-token', 'Content-Type': 'application/json' }
    assert.equal((await adminConfigCoreRoutes.request(url, { method:'POST' }, f.env)).status,401)
    assert.equal((await adminConfigCoreRoutes.request(url, {method:'POST',headers,body:'null'}, f.env)).status,400)
    const preview = await adminConfigCoreRoutes.request(url, {method:'POST',headers,body:'{}'}, f.env)
    assert.equal(preview.status,200)
    assert.equal(((await preview.json()) as any).p5_halted,true)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) AS n FROM paper_p5_rearms_v1').get()?.n,0)
    const body={...await request(f),dry_run:false}
    assert.equal((await adminConfigCoreRoutes.request(url,{method:'POST',headers,body:JSON.stringify(body)},f.env)).status,400)
    const applied=await adminConfigCoreRoutes.request(url,{method:'POST',headers:{...headers,'X-Confirm-P5-Rearm':'true'},body:JSON.stringify(body)},f.env)
    assert.equal(applied.status,200,await applied.clone().text())
    assert.equal(((await applied.json()) as any).mode,'persisted')
    const retry=await adminConfigCoreRoutes.request(url,{method:'POST',headers:{...headers,'X-Confirm-P5-Rearm':'true'},body:JSON.stringify(body)},f.env)
    assert.equal(((await retry.json()) as any).mode,'no_op')
  } finally { f.close() }
})


test('frozen July five-sell PnLs reproduce 4/5 halt; re-arm neither expires nor forgives later losses', async () => {
  const f = l4NativeFixture()
  try {
    // Captured 2026-09-14 account, ascending IDs 89..93. Historical sample, not current production.
    for (const pnl of [-861, -19983, -10590, -5441, 16961]) sell(f, 1, pnl)
    const before = await previewP5Recovery(f.env.PAPER_DB, 1)
    assert.deepEqual(before.summary, { losses:4, total:5 })
    assert.equal((await checkP5Losses(f.env.PAPER_DB, deps))?.halt, true)
    const body = await request(f)
    await applyP5Recovery(f.env.PAPER_DB, 1, body)
    assert.equal(await checkP5Losses(f.env.PAPER_DB, deps), null)
    const retained = f.sqls.paper.prepare(`SELECT SUM(json_extract(note,'$.realized_pnl')) AS pnl FROM paper_orders`).get()
    assert.equal(retained?.pnl, -19914)
  } finally { f.close() }
})
