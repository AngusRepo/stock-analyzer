import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'
import { seedDefaultStrategySpecRegistry } from './strategyLearning'

// H6: re-seeding the strategy registry must not refresh updated_at on unchanged rows.
function sqliteD1(sql: DatabaseSync): D1Database {
  const statement = (query: string, params: any[] = []) => ({
    bind: (...next: any[]) => statement(query, next),
    async all() { return { results: sql.prepare(query).all(...params) } },
    async first() { return sql.prepare(query).get(...params) ?? null },
    async run() { return { meta: { changes: Number(sql.prepare(query).run(...params).changes) } } },
  })
  return {
    prepare: (query: string) => statement(query),
    async batch(statements: any[]) { return Promise.all(statements.map((s) => s.run())) },
  } as unknown as D1Database
}

async function main() {
  const sql = new DatabaseSync(':memory:')
  const db = sqliteD1(sql)
  const T1 = '2026-10-01T00:00:00.000Z'
  const T2 = '2026-10-02T00:00:00.000Z'
  const T3 = '2026-10-03T00:00:00.000Z'
  const updatedAt = () => new Map(
    (sql.prepare('SELECT strategy_id, updated_at FROM strategy_spec_registry').all() as any[])
      .map((row) => [String(row.strategy_id), String(row.updated_at)]),
  )

  const first = await seedDefaultStrategySpecRegistry(db, { nowIso: T1 })
  assert.ok(first.seeded > 0)
  const afterFirst = updatedAt()
  assert.equal(afterFirst.size, DEFAULT_STRATEGY_SPECS.length)

  await seedDefaultStrategySpecRegistry(db, { nowIso: T2 })
  assert.deepEqual(updatedAt(), afterFirst, 'unchanged rows keep their updated_at on re-seed')

  const ids = [...afterFirst.keys()].sort()
  const [driftedId, shadowId] = ids
  sql.prepare(`UPDATE strategy_spec_registry SET thesis='stale thesis' WHERE strategy_id=?`).run(driftedId)
  sql.prepare(`UPDATE strategy_spec_registry SET status='shadow' WHERE strategy_id=?`).run(shadowId)
  await seedDefaultStrategySpecRegistry(db, { nowIso: T3 })
  const afterThird = updatedAt()
  assert.equal(afterThird.get(driftedId), T3, 'a changed spec field refreshes updated_at')
  assert.equal(afterThird.get(shadowId), T3, 'a status normalisation refreshes updated_at')
  const drifted = sql.prepare('SELECT thesis FROM strategy_spec_registry WHERE strategy_id=?').get(driftedId) as any
  assert.notEqual(drifted.thesis, 'stale thesis', 'the seed still rewrites drifted fields')
  const shadow = sql.prepare('SELECT status FROM strategy_spec_registry WHERE strategy_id=?').get(shadowId) as any
  assert.equal(shadow.status, 'candidate')
  for (const id of ids.slice(2)) assert.equal(afterThird.get(id), afterFirst.get(id), `${id} untouched`)

  console.log('strategy registry seed updated_at tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
