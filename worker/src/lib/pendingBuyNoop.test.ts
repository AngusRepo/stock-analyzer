import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { replacePendingBuyState, type PendingBuy } from './pendingBuyStore'
import { hasPendingBuyDebateChanges } from './pendingBuyDebateChange'

async function main() {
  const sqlite = new DatabaseSync(':memory:')
  const migration = readFileSync(new URL('../../domain-migrations/paper/0002_runtime_owned_tables.sql', import.meta.url), 'utf8')
  for (const table of ['pending_buy_runs', 'pending_buy_items']) {
    const ddl = migration.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0]
    assert(ddl)
    sqlite.exec(ddl)
  }
  const db = {
    prepare(sql: string) {
      let args: any[] = []
      return {
        bind(...values: any[]) { args = values; return this },
        async first() { return sqlite.prepare(sql).get(...args) ?? null },
        async all() { return { results: sqlite.prepare(sql).all(...args) } },
        async run() { return sqlite.prepare(sql).run(...args) },
      }
    },
  }
  const kv = new Map<string, string>()
  let failKv = false
  const env = { DB: db, KV: { put: async (key: string, value: string) => {
    if (failKv) throw new Error('kv_failure')
    kv.set(key, value)
  } } } as any
  const item: PendingBuy = { symbol: '2340', name: 'test', signal: 'BUY', confidence: .7,
    ml_entry_price: 43.5, ml_stop_loss: 30.15, ml_target1: 63.6, ml_target2: 83.6,
    reason: 'test', watch_points: ['l4_plan:test'], debate_verdict: 'PENDING', risk_pct: .1, kelly_pct: null }
  const params = { tradeDate: '2026-10-02', sourceRecoDate: '2026-10-01', status: 'ready' as const,
    debateStatus: 'pending' as const, pendingBuys: [item] }
  const first = await replacePendingBuyState(env, params)
  for (let i = 0; i < 100; i++) assert.equal(await replacePendingBuyState(env, params), first)
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM pending_buy_runs').get() as any).n, 1)
  const changed = { ...params, pendingBuys: [{ ...item, ml_entry_price: 44 }] }
  failKv = true
  await assert.rejects(replacePendingBuyState(env, changed), /kv_failure/)
  failKv = false
  const second = await replacePendingBuyState(env, changed)
  assert.notEqual(second, first)
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM pending_buy_runs').get() as any).n, 2,
    'retry after KV failure reuses committed D1 run')
  assert.equal(JSON.parse(kv.get('paper:pending_buys_meta:2026-10-02')!).run_id, second)
  assert.notEqual(await replacePendingBuyState(env, { ...changed,
    pendingBuys: [{ ...changed.pendingBuys[0], debate_verdict: 'DOWNGRADE', debate_status: 'completed' }] }), second)
  assert.equal(hasPendingBuyDebateChanges([item], [{ ...item, execution_status: 'checked_waiting',
    watch_points: [...item.watch_points, 'execution:checked_waiting:or15_signal_expired:newtime'] }]), false)
  assert.equal(hasPendingBuyDebateChanges([item], [{ ...item, debate_verdict: 'DOWNGRADE' }]), true)
  assert.equal(hasPendingBuyDebateChanges([item], [{ ...item,
    watch_points: [...item.watch_points, 'execution:pending:debate_retry:budget_exceeded'] }]), true)
  assert.equal(hasPendingBuyDebateChanges([item], []), true, 'REJECT/removal is a real revision')
  sqlite.close()
  console.log('Pending no-op: 100 identical updates -> 1 run; KV recovery and real changes PASS')
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
