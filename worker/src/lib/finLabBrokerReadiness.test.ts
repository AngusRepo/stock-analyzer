import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { brokerDailyReadiness } from './finLabBrokerReadiness'

function fixture(t: any) {
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  for (const table of ['canonical_broker_flow_daily', 'canonical_broker_rank_daily']) {
    sql.exec(`CREATE TABLE ${table} (stock_id TEXT, date TEXT, as_of_date TEXT, source TEXT, market_segment TEXT)`)
    sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
      INSERT INTO ${table}
      SELECT printf('%04d',x),'2026-09-22','2026-09-22','finlab.broker_transactions','LISTED_OTC' FROM n`)
  }
  class Statement {
    constructor(readonly text: string, readonly values: any[] = []) {}
    bind(...values: any[]) { return new Statement(this.text, values) }
    async first() { return sql.prepare(this.text).get(...this.values) ?? null }
  }
  const db = { prepare: (text: string) => new Statement(text) } as unknown as D1Database
  return { sql, check: () => brokerDailyReadiness(db, '2026-09-23') }
}

test('previous-session broker data blocks evening selection', async t => {
  const { check } = fixture(t)
  const checks = await check()
  assert(checks.every(check => !check.ok && check.summary.includes('target_rows=0/1000')))
})

test('complete target-session broker data passes', async t => {
  const { sql, check } = fixture(t)
  sql.exec("UPDATE canonical_broker_flow_daily SET date='2026-09-23', as_of_date='2026-09-23'; UPDATE canonical_broker_rank_daily SET date='2026-09-23', as_of_date='2026-09-23'")
  const checks = await check()
  assert(checks.every(check => check.ok && check.summary.includes('source_date=2026-09-23')))
})

test('relabelled prior-session broker data remains blocked', async t => {
  const { sql, check } = fixture(t)
  sql.exec("UPDATE canonical_broker_flow_daily SET date='2026-09-23'; UPDATE canonical_broker_rank_daily SET date='2026-09-23'")
  const checks = await check()
  assert(checks.every(check => !check.ok && check.summary.includes('target_rows=0/1000')))
})

test('one incomplete broker table blocks evening selection', async t => {
  const { sql, check } = fixture(t)
  sql.exec("UPDATE canonical_broker_flow_daily SET date='2026-09-23', as_of_date='2026-09-23'; UPDATE canonical_broker_rank_daily SET date='2026-09-23', as_of_date='2026-09-23' WHERE stock_id='0001'")
  const checks = await check()
  assert.equal(checks[0].ok, true)
  assert.equal(checks[1].ok, false)
  assert(checks[1].summary.includes('target_rows=1/1000'))
})
