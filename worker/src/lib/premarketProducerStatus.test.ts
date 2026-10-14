import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { loadPremarketProducerStates, premarketProducerDisplay, runPremarketProducerTask, type PremarketProducerRow } from './premarketProducerStatus'
import { classifySchedulerSummary } from './schedulerRunLogger'

const date = '2026-10-14'
const row: PremarketProducerRow = {
  business_date: date, stage: 'premarket_v2:news-analyst', canonical_run_id: `${date}:premarket_v2:news-analyst`,
  status: 'success', persisted_count: 1, attempt_count: 1, lease_expires_at: null,
  last_error: null, updated_at: '2026-10-13 22:45:49',
}

test('concurrent producer remains pending while its eventual success owns display', async () => {
  const summary = await runPremarketProducerTask('news-analyst', async () => {
    throw new Error('premarket_wait:news-analyst:running:attempt=1:next=2026-10-13 22:55:02')
  })
  assert.equal(classifySchedulerSummary(summary), 'triggered')
  assert.equal(premarketProducerDisplay('news-analyst', date, [row])?.lastStatus, 'success')
  assert.equal(premarketProducerDisplay('news-analyst', date, [row])?.lastError, undefined)
})

test('real producer failures and dependency failures are never converted to success or pending', async () => {
  for (const message of ['premarket_wait:news-analyst:error:attempt=3:next=2026-10-13 22:55:02',
    'premarket_wait:taifex-night', 'news_analyst_invalid_output',
    'premarket_wait:us-leading:running:attempt=1:next=2026-10-13 22:55:02']) {
    const failure = new Error(message)
    await assert.rejects(runPremarketProducerTask('news-analyst', async () => { throw failure }), error => error === failure)
  }
  assert.equal(premarketProducerDisplay('news-analyst', date, [{...row, status:'error', last_error:'invalid_output'}])?.lastError, 'invalid_output')
})

test('wrong date, run, stage, missing persistence, and expired lease cannot override tickets', () => {
  for (const change of [{business_date:'2026-10-13'}, {canonical_run_id:'wrong-run'},
    {stage:'premarket_v3:context'}, {persisted_count:0},
    {status:'running', lease_expires_at:'2026-10-13 22:45:00'}]) {
    assert.equal(premarketProducerDisplay('news-analyst', date, [{...row, ...change}], Date.parse('2026-10-13T22:50:00Z')), null)
  }
  assert.equal(premarketProducerDisplay('morning-setup', date, [row]), null)
  assert.equal(premarketProducerDisplay('news-analyst', date, [{...row, status:'running', lease_expires_at:'2026-10-13 22:55:02'}], Date.parse('2026-10-13T22:45:21Z'))?.lastStatus, 'running')
})

test('D1 producer read scopes both date and exact canonical identity', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE pipeline_stage_runs (business_date,stage,canonical_run_id,status,persisted_count,attempt_count,lease_expires_at,last_error,updated_at)')
  const fields = ['business_date','stage','canonical_run_id','status','persisted_count','attempt_count','lease_expires_at','last_error','updated_at'] as const
  for (const value of [row, {...row, business_date:'2026-10-13'}, {...row, canonical_run_id:'another-run'}, {...row, stage:'premarket_v3:context'}]) {
    sqlite.prepare('INSERT INTO pipeline_stage_runs VALUES (?,?,?,?,?,?,?,?,?)').run(...fields.map(field => value[field]))
  }
  const db = {prepare: (sql: string) => ({bind: (...params: string[]) => ({all: async () => ({results:sqlite.prepare(sql).all(...params)})})})} as unknown as D1Database
  assert.deepEqual(JSON.parse(JSON.stringify(await loadPremarketProducerStates(db, date))), [row])
  sqlite.close()
})
