/** Actual original Python publisher/ledger via private SQLite. Not market ROI. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { verifyNavFormalBaseline } from './pairedNavPromotionContext'
import { readCommittedNavBaseline } from './active8NavBaseline'
import type { Bindings } from '../types'

const source = process.env.NAV_L3_SQLITE
if (!source) {
  test('original Python NAV publication to Worker baseline', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    delete env.NODE_TEST_CONTEXT
    const python = process.env.NAV_TEST_PYTHON ?? path.resolve('../../ml-service/.venv/Scripts/python.exe')
    const result = spawnSync(python, ['-m', 'pytest', 'tests/test_nav_worker_l3_baseline.py',
      '-q', '--tb=short', '-p', 'no:cacheprovider'], { cwd: path.resolve('../ml-controller'),
      env, encoding: 'utf-8', timeout: 120000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
} else {
  const original = JSON.parse(fs.readFileSync(process.env.NAV_L3_BASELINE!, 'utf8'))
  const env = { ML_CONTROLLER_URL: 'https://isolated-controller.invalid', ML_CONTROLLER_SECRET: 'local-test-only' } as Bindings
  function fixture(t: any) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-worker-l3-'))
    const file = path.join(dir, 'copy.sqlite')
    fs.copyFileSync(source!, file)
    const sql = new DatabaseSync(file)
    t.after(() => { sql.close(); fs.unlinkSync(file); fs.rmdirSync(dir) })
    t.mock.timers.enable({ apis: ['Date'], now: new Date(process.env.NAV_L3_NOW!) })
    class Statement {
      constructor(readonly text: string, readonly values: any[] = []) {}
      bind(...values: any[]) { return new Statement(this.text, values) }
      async first() { return sql.prepare(this.text).get(...this.values) ?? null }
      async all() { return { results: sql.prepare(this.text).all(...this.values) } }
    }
    const db = { prepare: (text: string) => new Statement(text) } as unknown as D1Database
    const p = sql.prepare('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1').get()!
    const formal = Object.fromEntries(['artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum']
      .map(k => [k, p[k]]))
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://isolated-controller.invalid/nav/committed-l3-baseline')
      assert.equal(new Headers(init.headers).get('X-Controller-Token'), 'local-test-only')
      assert.deepEqual(JSON.parse(init.body as string), formal)
      return Response.json(original)
    })
    return { sql, db, formal }
  }
  test('genuine committed NAV PASS serves as L4/OPB baseline despite offline FAIL', async t => {
    const { sql, db, formal } = fixture(t)
    await verifyNavFormalBaseline(db, formal, env)
    assert.equal(sql.prepare('SELECT validation_decision FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?')
      .get(formal.artifact_id)?.validation_decision, 'FAIL')
  })
  for (const [name, mutate] of [
    ['uncommitted receipt', (sql: DatabaseSync) => sql.exec("UPDATE active8_ensemble_pointer_v1 SET promotion_evidence_json='{}'")],
    ['changed output bytes', (sql: DatabaseSync) => sql.exec("UPDATE active8_ensemble_artifacts_v1 SET payload_json='{}' WHERE state='production'")],
    ['missing base history', (sql: DatabaseSync) => sql.exec('DELETE FROM model_champion_history')],
    ['changed base pointer', (sql: DatabaseSync) => sql.exec("UPDATE model_champion_pointers SET champion_version='different'")],
    ['future publication', (sql: DatabaseSync) => sql.exec("UPDATE active8_ensemble_pointer_v1 SET promoted_at='2099-01-01 00:00:00'")],
  ] as const) {
    test(name + ' cannot become a valid baseline', async t => {
      const { sql, db, formal } = fixture(t)
      mutate(sql)
      await assert.rejects(verifyNavFormalBaseline(db, formal, env))
    })
  }
  test('exact original sources are fenced in the downstream transaction', async t => {
    const { sql, db, formal } = fixture(t)
    const fence = await readCommittedNavBaseline(db, env, formal)
    sql.exec('CREATE TABLE isolated_effect(value TEXT)')
    const run = () => {
      sql.exec('BEGIN')
      try {
        sql.prepare("INSERT INTO isolated_effect VALUES('downstream')").run()
        sql.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE json('source_changed') END`).get(...fence.params)
        sql.exec('COMMIT')
      } catch (error) { sql.exec('ROLLBACK'); throw error }
    }
    run()
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM isolated_effect').get()?.n, 1)
    sql.exec("UPDATE model_champion_pointers SET champion_version='raced'")
    assert.throws(run)
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM isolated_effect').get()?.n, 1)
  })
  test('unordered source rows may arrive in another order without changing authority', async t => {
    const { db, formal } = fixture(t)
    const response = structuredClone(original)
    for (const anchor of response.anchors) if (!anchor.sql.includes('ORDER BY')) anchor.rows.reverse()
    t.mock.method(globalThis, 'fetch', async () => Response.json(response))
    await verifyNavFormalBaseline(db, formal, env)
  })
  test('unavailable verifier and caller PASS cannot replace original authority', async t => {
    const { db, formal } = fixture(t)
    await assert.rejects(verifyNavFormalBaseline(db, formal))
    t.mock.method(globalThis, 'fetch', async () => Response.json({ decision: 'PASS' }))
    await assert.rejects(verifyNavFormalBaseline(db, formal, env))
    t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }))
    await assert.rejects(verifyNavFormalBaseline(db, formal, env))
  })
  for (const [label, change] of [
    ['stale response', (r: any) => { r.observed_at = '2026-09-21T14:00:00Z' }],
    ['future response', (r: any) => { r.observed_at = '2099-01-01T14:00:00Z' }],
    ['missing family', (r: any) => { r.anchors = r.anchors.filter((a: any) => !a.sql.includes('model_champion_history')) }],
    ['SQL injection', (r: any) => { r.anchors[0].sql += '; DELETE FROM model_champion_history' }],
    ['wrong identity', (r: any) => { r.formal.artifact_id = 'wrong' }],
  ] as const) {
    test(label + ' is rejected before any write', async t => {
      const { db, formal } = fixture(t)
      const response = structuredClone(original)
      change(response)
      t.mock.method(globalThis, 'fetch', async () => Response.json(response))
      await assert.rejects(verifyNavFormalBaseline(db, formal, env))
    })
  }
}
