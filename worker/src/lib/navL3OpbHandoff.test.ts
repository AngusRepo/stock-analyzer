/** Original sequential Python NAV evidence -> real Worker commit/projection. NOT ROI. */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { commitOpbNavChampion, projectOpbNavChampion } from './opbNavPublication'

const source = process.env.NAV_L3_OPB_FIXTURE
if (source) test('original NAV L3 -> original NAV OPB -> projection -> next-day serving', async t => {
  const f = JSON.parse(fs.readFileSync(source, 'utf8'))
  const sql = new DatabaseSync(f.database)
  t.after(() => sql.close())
  const DateOwner = globalThis.Date
  globalThis.Date = class extends DateOwner {
    constructor(value?: any) { super(value === undefined ? f.now : value) }
    static now() { return new DateOwner(f.now).getTime() }
  } as DateConstructor
  t.after(() => { globalThis.Date = DateOwner })
  sql.function('current_timestamp', () => new Date(f.now).toISOString().replace('T', ' ').slice(0, 19))
  const db: any = { prepare(text: string) {
    const statement = sql.prepare(text); let params: any[] = []
    return { bind(...values: any[]) { params = values; return this },
      execute() { statement.run(...params) },
      async first() { return statement.get(...params) ?? null },
      async all() { return { success: true, results: statement.all(...params) } } }
  }, async batch(statements: any[]) {
    sql.exec('BEGIN')
    try { const result = statements.map(s => { s.execute(); return { success: true } }); sql.exec('COMMIT'); return result }
    catch (e) { sql.exec('ROLLBACK'); throw e }
  } }
  const current = structuredClone(f.current)
  const readCurrent = async () => ({ tradingConfig: structuredClone(current.trading_config), riskConfig: structuredClone(current.risk_config) })
  function bridge(mode: string, formal?: any) {
    const result = spawnSync(f.python, ['tests/nav_l3_opb_bridge.py'], { cwd: path.resolve('../ml-controller'),
      input: JSON.stringify({ mode, formal, database: f.database, now: f.now, current }),
      encoding: 'utf8', env: { ...process.env, PYTHONPATH: '.;../.tmp/nav-controller-runtime-deps' }, timeout: 60000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return JSON.parse(result.stdout)
  }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (input: any, options?: any) => {
    assert.match(String(input), /\/nav\/committed-l3-baseline$/)
    return Response.json(bridge('baseline', JSON.parse(options.body)))
  }
  t.after(() => { globalThis.fetch = oldFetch })
  const env = { ML_CONTROLLER_SECRET: 'private-fixture', ML_CONTROLLER_URL: 'https://private-fixture.invalid' } as any
  const reviews = sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()
  assert.equal(bridge('serving').verified, true)
  const receipt = await commitOpbNavChampion(db, { artifactId: f.payload.artifact_id,
    artifactChecksum: f.payload.artifact_checksum, gate: f.payload.prospective_validation,
    currentConfigReader: readCurrent, navBindings: env }, new Date(f.now))
  const values = new Map<string, string>([['trading:config', JSON.stringify(current.trading_config)]])
  const kv = { async get(key: string, type: string) { const raw = values.get(key); return raw ? type === 'json' ? JSON.parse(raw) : raw : null },
    async put(key: string, value: string) { values.set(key, value); if (key === 'trading:config') current.trading_config = JSON.parse(value) } } as any
  await projectOpbNavChampion(db, kv, receipt, readCurrent, env)
  assert.equal(current.trading_config.alphaFramework.allocation.controller, 'OnlinePortfolioBandit')
  assert.equal(bridge('control').verified, true)
  f.now = '2026-10-07T14:00:00+00:00'
  const nextDay = bridge('serving')
  assert.equal(nextDay.verified, true)
  assert.equal(nextDay.eligible_model_count, 8)
  assert.equal(sql.prepare('SELECT promotion_evidence_json FROM active8_ensemble_pointer_v1').get()?.promotion_evidence_json,
    f.l3_receipt.promotion_evidence_json)
  assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), reviews)
  const projected = structuredClone(current.trading_config)
  for (const [name, change] of [
    ['unapproved risk', () => { current.risk_config.system.killSwitch = !current.risk_config.system.killSwitch }],
    ['unapproved sizing', () => { current.trading_config.position.maxPctOfPortfolio = .125 }],
    ['unapproved prior', () => { current.trading_config.alphaFramework.allocation.opbArmPrior.arm_priors[0].prior_reward_mean += .1 }],
    ['unapproved controller', () => { current.trading_config.alphaFramework.allocation.controller = 'SparseTangent' }],
    ['changed source', () => { current.allocator_source_identity.changed = true }],
  ] as const) {
    await t.test(`reject ${name} after valid publication`, () => {
      const saved = structuredClone(current)
      try { change(); assert.throws(() => bridge('serving'), /configuration_changed|paired_nav_opb_control/) }
      finally { for (const key of Object.keys(current)) delete current[key]; Object.assign(current, saved) }
    })
  }
  for (const [name, mutation] of [
    ['OPB history', "UPDATE model_champion_history SET evidence_json='{}' WHERE model_name='opb_arm_prior'"],
    ['OPB registry', "UPDATE model_artifact_registry SET state='archived' WHERE model_name='opb_arm_prior'"],
    ['EV payload', "UPDATE expected_return_artifact_payloads SET artifact_json='{}'"],
  ] as const) {
    await t.test(`reject changed ${name} after valid publication`, () => {
      // Commit the private mutation so the independent read-only verifier sees
      // it; restore the exact original row afterward, never a production DB.
      const table = name === 'OPB history' ? 'model_champion_history' : name === 'OPB registry'
        ? 'model_artifact_registry' : 'expected_return_artifact_payloads'
      const rows = sql.prepare(`SELECT * FROM ${table}`).all()
      try { sql.exec(mutation); assert.throws(() => bridge('serving'), /paired_nav_opb_control/) }
      finally {
        const key = name === 'OPB history' ? 'event_id' : 'artifact_id'
        const field = name === 'OPB history' ? 'evidence_json' : name === 'OPB registry' ? 'state' : 'artifact_json'
        for (const row of rows) {
          sql.prepare(`UPDATE ${table} SET ${field}=? WHERE ${key}=?`).run(row[field], row[key])
        }
      }
    })
  }
  assert.equal(bridge('serving').verified, true)
  const before = sql.prepare('SELECT total_changes() n').get()?.n
  assert.deepEqual(await commitOpbNavChampion(db, { artifactId: f.payload.artifact_id,
    artifactChecksum: f.payload.artifact_checksum, gate: { decision: 'HOLD' }, currentConfigReader: readCurrent, navBindings: env }), receipt)
  assert.equal((await projectOpbNavChampion(db, kv, receipt, readCurrent, env)).snapshot, null)
  assert.equal(sql.prepare('SELECT total_changes() n').get()?.n, before)
  assert.deepEqual(current.trading_config, projected)
  assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), reviews)
})
else test('original sequential L3 and OPB evidence', () => {
  const python = process.env.NAV_TEST_PYTHON ?? path.resolve('../../ml-service/.venv/Scripts/python.exe')
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: '../.tmp/nav-controller-runtime-deps' }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(python, ['-m', 'pytest', 'tests/test_nav_l3_opb_handoff.py', '-q', '--tb=short'],
    { cwd: path.resolve('../ml-controller'), env, encoding: 'utf8', timeout: 240000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
