import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Hono } from 'hono'
import { signJWT } from './auth'
import { TODO_READY_ERROR, todoBoardRoutes, validTodoCardId } from '../routes/todoBoardRoutes'

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
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = body === undefined ? {} : { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await app.request(`https://stockvision.invalid${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env)
    return { status: res.status, json: await res.json() as any }
  }
  return { sql, db, call }
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

  const badDate = await call('PATCH', '/api/admin/todo/cards/K15', { release_date: '2026-13-01' })
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

test('actor is the admin JWT email, or service for the service token', async () => {
  const { sql, call } = harness({ LOCAL_AUTH_BYPASS: '0', ENVIRONMENT: 'production', STOCKVISION_AUTH_TOKEN: 'svc-test-token' })
  const adminJwt = await signJWT({ sub: '7', email: 'wei@example.com', role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-only')
  assert.equal((await call('POST', '/api/admin/todo/cards', { id: 'A1', title: 'admin card' }, adminJwt)).status, 201)
  assert.equal((await call('PATCH', '/api/admin/todo/cards/A1', { lane: 'doing' }, adminJwt)).status, 200)
  assert.equal((await call('POST', '/api/admin/todo/cards', { id: 'S1', title: 'service card' }, 'svc-test-token')).status, 201)
  const userJwt = await signJWT({ sub: '8', email: 'user@example.com', role: 'user', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-only')
  assert.equal((await call('POST', '/api/admin/todo/cards', { id: 'U1', title: 'x' }, userJwt)).status, 403)
  const rows = sql.prepare('SELECT id, updated_by FROM todo_cards ORDER BY id').all() as any[]
  assert.deepEqual(rows.map((r) => [r.id, r.updated_by]), [['A1', 'wei@example.com'], ['S1', 'service']])
  const events = sql.prepare('SELECT card_id, action, actor FROM todo_card_events ORDER BY id').all() as any[]
  assert.deepEqual(events.map((e) => [e.card_id, e.action, e.actor]),
    [['A1', 'create', 'wei@example.com'], ['A1', 'move', 'wei@example.com'], ['S1', 'create', 'service']])
})

test('duplicate PR numbers, archived cards and a racing CHECK violation are rejected', async () => {
  const { sql, db, call } = harness()
  const dup = await call('POST', '/api/admin/todo/cards', { id: 'D1', title: 't', prs: [PR, { ...PR, title: 'again' }] })
  assert.equal(dup.status, 400)
  assert.equal(dup.json.error, 'prs_duplicate_number')

  assert.equal((await call('POST', '/api/admin/todo/cards', { id: 'R1', title: 't', lane: 'doing', release_date: '2026-11-03', prs: [PR] })).status, 201)
  // Another writer clears the PRs between the route's ready check and its batch: the table CHECK
  // fails and the route answers the ready error, not a 500.
  const batch = db.batch
  db.batch = async (statements: any[]) => {
    sql.exec("UPDATE todo_cards SET prs_json='[]' WHERE id='R1'")
    return batch(statements)
  }
  const raced = await call('PATCH', '/api/admin/todo/cards/R1', { lane: 'ready' })
  db.batch = batch
  assert.equal(raced.status, 400)
  assert.equal(raced.json.error, TODO_READY_ERROR)
  assert.equal((sql.prepare("SELECT lane FROM todo_cards WHERE id='R1'").get() as any).lane, 'doing')

  assert.equal((await call('POST', '/api/admin/todo/cards/R1/archive')).status, 200)
  const archivedPatch = await call('PATCH', '/api/admin/todo/cards/R1', { title: 'renamed' })
  assert.equal(archivedPatch.status, 409)
  assert.equal(archivedPatch.json.error, 'todo_card_archived')
  const restored = await call('POST', '/api/admin/todo/cards/R1/archive', { archived: false })
  assert.equal(restored.status, 200)
  assert.equal(restored.json.card.archived, false)
  assert.equal((await call('PATCH', '/api/admin/todo/cards/R1', { title: 'renamed' })).status, 200)
})

test('tracker ids with #, spaces and full-width characters round-trip through encoded PATCH and archive', async () => {
  const { sql, call } = harness()
  for (const id of ['K11#2', 'D9／D-5', 'B3 A6（MEM-M3）', 'E4-a～E4-l', 'O06＋M10#2']) assert.equal(validTodoCardId(id), true, id)
  for (const id of ['', ' K1', 'K1 ', 'D9/D-5', 'a?b', '50%', 'a\\b', 'a\u0007b', 'x'.repeat(65)]) assert.equal(validTodoCardId(id), false, JSON.stringify(id))
  assert.equal(validTodoCardId('全'.repeat(64)), true)
  assert.equal((await call('POST', '/api/admin/todo/cards', { id: 'D9/D-5', title: 'ascii slash' })).json.error, 'id_invalid')
  assert.equal((await call('POST', '/api/admin/todo/cards', { id: ' K11', title: 'leading space' })).json.error, 'id_invalid')

  for (const id of ['K11#2', 'D9／D-5', 'B3 A6（MEM-M3）']) {
    assert.equal((await call('POST', '/api/admin/todo/cards', { id, title: id, deadline: 'K18-B 後' })).status, 201, id)
    const patched = await call('PATCH', `/api/admin/todo/cards/${encodeURIComponent(id)}`, { lane: 'doing', deadline: '11/5 月訓前' })
    assert.equal(patched.status, 200, id)
    assert.equal(patched.json.card.id, id)
    assert.equal(patched.json.card.deadline, '11/5 月訓前')
    const archived = await call('POST', `/api/admin/todo/cards/${encodeURIComponent(id)}/archive`)
    assert.equal(archived.status, 200, id)
    assert.equal(archived.json.card.archived, true)
  }
  const rows = sql.prepare("SELECT id, lane, deadline, archived FROM todo_cards ORDER BY id").all() as any[]
  assert.deepEqual(rows.map((r) => [r.id, r.lane, r.deadline, r.archived]).sort(), [
    ['B3 A6（MEM-M3）', 'doing', '11/5 月訓前', 1], ['D9／D-5', 'doing', '11/5 月訓前', 1], ['K11#2', 'doing', '11/5 月訓前', 1],
  ].sort())
  assert.equal((await call('POST', '/api/admin/todo/cards', { id: 'K12#3', title: 't', deadline: 'x'.repeat(120) })).status, 201)
  const tooLong = await call('PATCH', `/api/admin/todo/cards/${encodeURIComponent('K12#3')}`, { deadline: 'x'.repeat(121) })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.error, 'deadline_too_long')
})
