// Actual upgrade transaction on private native D1; never run against prod.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'

const migration = fs.readFileSync('domain-migrations/learning/0046_route_nav_diagnostic_floor.sql', 'utf8')
  .split(';').map(s => s.trim()).filter(Boolean)

async function fixture(run: (db: D1Database) => Promise<void>) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("private") } }',
    d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING') as unknown as D1Database
    const baseline = fs.readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
    for (const name of ['strategy_route_calibration_runs_v1', 'strategy_route_calibration_head_v1']) {
      const ddl = baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))?.[0]
      assert(ddl)
      await db.prepare(ddl).run()
    }
    await db.prepare(`INSERT INTO strategy_route_calibration_runs_v1
      (run_id,artifact_version,as_of_date,status,candidate_route_version,route_floor,sample_count,date_count,gate_json)
      VALUES('existing','strategy-route-calibration-v2','2026-09-07','promoted','existing-route',81.5,400,20,'{}')`).run()
    await db.prepare(`INSERT INTO strategy_route_calibration_head_v1 VALUES
      (1,'existing','strategy-route-calibration-v2','existing-route',81.5,'2026-09-07T14:00:00Z')`).run()
    await run(db)
  } finally { await mf.dispose() }
}

const state = async (db: D1Database) => ({
  heads: (await db.prepare('SELECT * FROM strategy_route_calibration_head_v1').all()).results,
  runs: (await db.prepare('SELECT * FROM strategy_route_calibration_runs_v1').all()).results,
})

test('0046 preserves every existing route field and permits null only for NAV', async () => {
  await fixture(async db => {
    const before = await state(db)
    await db.batch(migration.map(sql => db.prepare(sql)))
    assert.deepEqual(await state(db), before)
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, [])
    await assert.rejects(() => db.prepare('UPDATE strategy_route_calibration_head_v1 SET route_floor=NULL').run())
    assert.deepEqual(await state(db), before)
    const columns = (await db.prepare('PRAGMA table_info(strategy_route_calibration_head_v1)').all<any>()).results
    assert.equal(columns.find(row => row.name === 'route_floor').notnull, 0)
  })
})

test('0046 failing after any upgrade statement restores the original head and schema', async () => {
  await fixture(async db => {
    const before = await state(db)
    for (let index = 0; index < migration.length; index++) {
      const statements = migration.map(sql => db.prepare(sql))
      statements.splice(index + 1, 0, db.prepare("SELECT json('injected_route_migration_failure')"))
      await assert.rejects(() => db.batch(statements))
      assert.deepEqual(await state(db), before)
      const columns = (await db.prepare('PRAGMA table_info(strategy_route_calibration_head_v1)').all<any>()).results
      assert.equal(columns.find(row => row.name === 'route_floor').notnull, 1)
      assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='strategy_route_calibration_head_nav_migration'").first(), null)
    }
  })
})
