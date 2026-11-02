import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { TODO_READY_ERROR, todoBoardRoutes } from '../routes/todoBoardRoutes'

const MIGRATION = new URL('../../domain-migrations/ops/0024_todo_board.sql', import.meta.url)

function opsShim() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync(MIGRATION, 'utf8'))
  const prepare = (query: string) => {
    let args: any[] = []
    const statement = {
      bind(...values: any[]) { args = values; return statement },
      async first() { return sql.prepare(query).get(...args) ?? null },
      async all() { return { results: sql.prepare(query).all(...args), meta: { size_after: 0 } } },
      async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } } },
    }
    return statement
  }
  const batch = async (statements: Array<{ run(): Promise<unknown> }>) => {
    sql.exec('SAVEPOINT todo_batch')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      sql.exec('RELEASE todo_batch')
      return results
    } catch (error) {
      sql.exec('ROLLBACK TO todo_batch; RELEASE todo_batch')
      throw error
    }
  }
  return { sql, db: { prepare, batch } }
}

function harness(envOverrides: Record<string, unknown> = {}) {
  const { sql, db } = opsShim()
  const app = new Hono()
  app.route('/', todoBoardRoutes as any)
  const env = { LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test', OPS_DB: db, JWT_SECRET: 'test-only', ...envOverrides }
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`https://stockvision.invalid${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
    return { status: res.status, json: await res.json() as any }
  }
  return { sql, call }
}

const PR = { number: 122, title: 'R33-REL 11/3 release', summary: 'K18-B 與 todo board' }

test('create, duplicate id, ready gate, events, archive', async () => {
  const { sql, call } = harness()

  const created = await call('POST', '/api/admin/todo/cards', { id: 'K15', title: 'K15 runbook', owner: 'parent', deadline: '2026-11-03', section: 'R33' })
  assert.equal(created.status, 201)
  assert.equal(created.json.card.lane, 'todo')
  assert.deepEqual(created.json.card.prs, [])

  const duplicate = await call('POST', '/api/admin/todo/cards', { id: 'K15', title: 'again' })
  assert.equal(duplicate.status, 409)

  const badDate = await call('PATCH', '/api/admin/todo/cards/K15', { deadline: '2026-13-01' })
  assert.equal(badDate.status, 400)
  const badPr = await call('PATCH', '/api/admin/todo/cards/K15', { prs: [{ number: 0, title: 'x', summary: '' }] })
  assert.equal(badPr.status, 400)

  const noRelease = await call('PATCH', '/api/admin/todo/cards/K15', { lane: 'ready', prs: [PR] })
  assert.equal(noRelease.status, 400)
  assert.equal(noRelease.json.error, TODO_READY_ERROR)
  const noPrs = await call('PATCH', '/api/admin/todo/cards/K15', { lane: 'ready', release_date: '2026-11-03' })
  assert.equal(noPrs.status, 400)
  assert.equal(noPrs.json.error, TODO_READY_ERROR)
  const readyOnCreate = await call('POST', '/api/admin/todo/cards', { id: 'FG-02', title: 'x', lane: 'ready' })
  assert.equal(readyOnCreate.status, 400)
  assert.equal(readyOnCreate.json.error, TODO_READY_ERROR)

  const ready = await call('PATCH', '/api/admin/todo/cards/K15', { lane: 'ready', release_date: '2026-11-03', prs: [PR], position: 2 })
  assert.equal(ready.status, 200)
  assert.equal(ready.json.card.lane, 'ready')
  assert.equal(ready.json.card.release_date, '2026-11-03')
  assert.deepEqual(ready.json.card.prs, [PR])

  const clearPrs = await call('PATCH', '/api/admin/todo/cards/K15', { prs: [] })
  assert.equal(clearPrs.status, 400)
  assert.equal(clearPrs.json.error, TODO_READY_ERROR)
  const clearDate = await call('PATCH', '/api/admin/todo/cards/K15', { release_date: '' })
  assert.equal(clearDate.status, 400)
  assert.equal(clearDate.json.error, TODO_READY_ERROR)

  const events = sql.prepare('SELECT action, from_lane, to_lane, actor FROM todo_card_events WHERE card_id = ? ORDER BY id').all('K15') as any[]
  assert.deepEqual(events.map((e) => [e.action, e.from_lane, e.to_lane]), [['create', null, 'todo'], ['move', 'todo', 'ready']])
  assert.equal(events[0].actor, 'service')

  const listed = await call('GET', '/api/admin/todo/cards')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.json.cards.map((card: any) => card.id), ['K15'])
  assert.deepEqual(listed.json.cards[0].prs, [PR])

  const archived = await call('POST', '/api/admin/todo/cards/K15/archive')
  assert.equal(archived.status, 200)
  assert.equal(archived.json.card.archived, true)
  assert.deepEqual((await call('GET', '/api/admin/todo/cards')).json.cards, [])
  const withArchived = await call('GET', '/api/admin/todo/cards?include_archived=1')
  assert.deepEqual(withArchived.json.cards.map((card: any) => card.id), ['K15'])
  const lastEvent = sql.prepare('SELECT action FROM todo_card_events WHERE card_id = ? ORDER BY id DESC LIMIT 1').get('K15') as any
  assert.equal(lastEvent.action, 'archive')
})

test('the table CHECK rejects a ready card without release date or PRs written past the route', () => {
  const { sql } = opsShim()
  assert.throws(() => sql.exec("INSERT INTO todo_cards(id,title,lane) VALUES('X1','t','ready')"), /CHECK constraint failed/)
  assert.throws(() => sql.exec("INSERT INTO todo_cards(id,title,lane,release_date,prs_json) VALUES('X2','t','ready','2026-11-03','[]')"), /CHECK constraint failed/)
  assert.throws(() => sql.exec("INSERT INTO todo_cards(id,title,lane,release_date,prs_json) VALUES('X3','t','ready','  ','[{\"number\":1}]')"), /CHECK constraint failed/)
  assert.throws(() => sql.exec("INSERT INTO todo_cards(id,title,lane) VALUES('X4','t','backlog')"), /CHECK constraint failed/)
  assert.throws(() => sql.exec("INSERT INTO todo_cards(id,title,lane,prs_json) VALUES('X5','t','todo','{}')"), /CHECK constraint failed/)
  assert.throws(() => sql.exec("INSERT INTO todo_cards(id,title,lane,archived) VALUES('X6','t','todo',2)"), /CHECK constraint failed/)
  sql.exec("INSERT INTO todo_cards(id,title,lane,release_date,prs_json) VALUES('OK','t','ready','2026-11-03','[{\"number\":1,\"title\":\"a\",\"summary\":\"b\"}]')")
  assert.throws(() => sql.exec("UPDATE todo_cards SET prs_json='[]' WHERE id='OK'"), /CHECK constraint failed/)
})

test('without bypass or token every route returns 401', async () => {
  const { call } = harness({ LOCAL_AUTH_BYPASS: '0', ENVIRONMENT: 'production' })
  for (const [method, path, body] of [
    ['GET', '/api/admin/todo/cards', undefined],
    ['POST', '/api/admin/todo/cards', { id: 'K15', title: 't' }],
    ['PATCH', '/api/admin/todo/cards/K15', { title: 't' }],
    ['POST', '/api/admin/todo/cards/K15/archive', undefined],
  ] as const) {
    const res = await call(method, path, body)
    assert.equal(res.status, 401, `${method} ${path}`)
  }
})
