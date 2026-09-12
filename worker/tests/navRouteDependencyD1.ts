// Real serving-reader/CAS semantics; synthetic control data, not NAV efficacy.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { readNavRouteDependency } from '../src/lib/navRouteDependency'
import { STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION as version,
  STRATEGY_ROUTE_CHALLENGER_VERSION as routeVersion } from '../src/lib/strategyRouteCalibration'

async function fixture(run: (db: D1Database, publish: () => Promise<void>) => Promise<void>) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("private") } }', d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING') as unknown as D1Database
    const baseline = readFileSync('domain-migrations/learning/0001_learning_baseline.sql', 'utf8')
    for (const table of ['strategy_route_calibration_runs_v1', 'strategy_route_calibration_head_v1']) {
      const ddl = baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0]
      assert(ddl)
      await db.prepare(ddl).run()
    }
    const publish = async () => { await db.batch([
      db.prepare(`INSERT INTO strategy_route_calibration_runs_v1
        (run_id,artifact_version,as_of_date,status,candidate_route_version,route_floor,sample_count,date_count,gate_json)
        VALUES('original-route',?,'2026-09-01','promoted',?,30,100,20,'{}')`).bind(version, routeVersion),
      db.prepare(`INSERT INTO strategy_route_calibration_head_v1
        (singleton_id,run_id,artifact_version,candidate_route_version,route_floor)
        VALUES(1,'original-route',?,?,30)`).bind(version, routeVersion),
    ]) }
    await run(db, publish)
  } finally { await mf.dispose() }
}

test('no-head observation cannot authorize a commit after a route appears', () => fixture(async (db, publish) => {
  const original = await readNavRouteDependency(db, null)
  assert.equal(original.matches, true)
  await db.batch(original.statements)
  await publish()
  assert.equal((await readNavRouteDependency(db, null)).matches, false)
  await assert.rejects(() => db.batch(original.statements), /malformed JSON/)
}))

test('lineage-only changes are not a different routing policy, but mutation during commit still requires retry', () => fixture(async (db, publish) => {
  await publish()
  const expected = { runId: 'different-historical-log-id', routeVersion, routeFloor: 30 }
  const original = await readNavRouteDependency(db, expected)
  assert.equal(original.matches, true)
  await db.batch(original.statements)
  await db.prepare("UPDATE strategy_route_calibration_head_v1 SET promoted_at='2026-09-02T00:00:00Z'").run()
  assert.equal((await readNavRouteDependency(db, expected)).matches, true)
  await assert.rejects(() => db.batch(original.statements), /malformed JSON/)
  await db.batch([
    db.prepare('UPDATE strategy_route_calibration_runs_v1 SET route_floor=31'),
    db.prepare('UPDATE strategy_route_calibration_head_v1 SET route_floor=31'),
  ])
  assert.equal((await readNavRouteDependency(db, expected)).matches, false)
}))

test('broken serving head is an explicit error, never equivalent to no route', () => fixture(async (db, publish) => {
  await publish()
  await db.prepare("UPDATE strategy_route_calibration_runs_v1 SET status='fail'").run()
  await assert.rejects(() => readNavRouteDependency(db, null), /head_invalid/)
}))
