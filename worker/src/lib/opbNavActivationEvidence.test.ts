/** Original Python formal allocation seals -> actual Hono -> daily transport.
 * All DB/KV state is private; synthetic execution is not investment ROI.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { adminConfigCoreRoutes } from '../routes/adminConfigCoreRoutes'

const source = process.env.NAV_OPB_CONTROL_FIXTURE
if (!source) {
  test('original formal allocation returns verified activation over HTTP', () => {
    const local = path.resolve('../../ml-service/.venv/Scripts/python.exe')
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.env.NAV_TEST_PYTHON ?? local, ['-m', 'pytest',
      'tests/test_nav_opb_daily_primary.py', '-k', 'original_ten_session', '-q', '--tb=short'],
      { cwd: path.resolve('../ml-controller'), env, encoding: 'utf-8', timeout: 120000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
} else {
  const original = JSON.parse(fs.readFileSync(source, 'utf8'))
  const responses: any[] = []
  function setup(t: any, variants: any[]) {
    const sql = new DatabaseSync(':memory:')
    let afterParts: (() => void) | null = null
    t.after(() => sql.close())
    const tables = structuredClone(original.tables)
    for (const variant of variants) {
      for (const [name, value] of Object.entries(variant.tables) as [string, any][]) {
        tables[name] ??= { schema: value.schema, rows: [] }
        tables[name].rows.push(...value.rows)
      }
    }
    for (const value of Object.values(tables) as any[]) sql.exec(value.schema)
    sql.exec('BEGIN; PRAGMA defer_foreign_keys=ON')
    for (const [name, value] of Object.entries(tables) as [string, any][]) {
      for (const row of value.rows) {
        const fields = Object.keys(row)
        sql.prepare(`INSERT INTO ${name}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`)
          .run(...fields.map(key => row[key]))
      }
    }
    sql.exec('COMMIT')
    const db = { prepare(text: string) {
      const statement = sql.prepare(text)
      let params: any[] = []
      return { bind(...values: any[]) { params = values; return this },
        async first() { return statement.get(...params) ?? null },
        async all() {
          const results = statement.all(...params)
          if (text.startsWith('SELECT part_no,payload_text') && afterParts) { const run = afterParts; afterParts = null; run() }
          return { results }
        } }
    }, async batch() { assert.fail('Already committed activation readback must not write D1') } }
    const values = new Map([['trading:config', JSON.stringify(original.trading_config)],
      ['trading:risk_config', JSON.stringify(original.risk_config)]])
    const kv = { async get(key: string, type: string) {
      const raw = values.get(key); return raw ? type === 'json' ? JSON.parse(raw) : raw : null
    }, async put() { assert.fail('Exact projected configuration must not be republished') } }
    const row = sql.prepare("SELECT * FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get() as any
    const evidence = JSON.parse(row.promotion_evidence_json)
    const env = { DB: { prepare() { assert.fail('wrong D1 owner') } }, LEARNING_DB: db,
      MULTI_D1_ACTIVE_DOMAINS: 'learning', MULTI_D1_STRICT: 'true', KV: kv,
      STOCKVISION_AUTH_TOKEN: 'local-fixture-token' } as any
    return { sql, values, race(fn: () => void) { afterParts = fn }, async request() {
      const OriginalDate = globalThis.Date
      globalThis.Date = class extends OriginalDate {
        constructor(value?: any) { super(value === undefined ? original.now : value) }
        static now() { return new OriginalDate(original.now).getTime() }
      } as DateConstructor
      try {
        return await (await adminConfigCoreRoutes.request('/api/admin/config/opb/promote', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-fixture-token' },
          body: JSON.stringify({ artifact_id: evidence.artifact_id, artifact_checksum: evidence.artifact_checksum,
            prospective_validation: { decision: 'HOLD' } }),
        }, env)).json() as any
      } finally { globalThis.Date = OriginalDate }
    } }
  }
  for (const variant of original.variants) {
    test(`real sealed ${variant.expected} is consumed without a second write or review`, async t => {
      const f = setup(t, [variant])
      const changes = f.sql.prepare('SELECT total_changes() AS n').get()?.n
      const result = await f.request()
      assert.equal(result.config_projection_verified, true, JSON.stringify(result))
      assert.equal(result.success, variant.expected !== 'failed', JSON.stringify(result))
      assert.equal(result.control.status, variant.expected)
      assert.equal(result.control.snapshot_id, variant.snapshot_id)
      assert.equal(result.control_activation_verified, variant.expected === 'completed')
      assert.equal(result.completion_scope, 'publication')
      assert.deepEqual(await f.request(), result)
      assert.equal(f.sql.prepare('SELECT total_changes() AS n').get()?.n, changes)
      responses.push(result)
    })
  }
  test('a later failed allocation cannot be hidden by an earlier successful one', async t => {
    const f = setup(t, original.variants)
    const result = await f.request()
    assert.equal(result.success, false, JSON.stringify(result))
    assert.equal(result.control.status, 'failed')
    assert.equal(result.control.snapshot_id, original.variants.at(-1).snapshot_id)
  })
  test('pagination skips derived contexts without losing the original formal allocation', async t => {
    const formal = original.variants[0]
    const derived = Array.from({ length: 40 }, (_, i) => {
      const value = structuredClone(formal)
      const manifest = value.tables.paired_nav_frozen_manifests_v1.rows[0]
      const parts = value.tables.paired_nav_frozen_parts_v1.rows.sort((a: any, b: any) => a.part_no - b.part_no)
      const payload = JSON.parse(parts.map((p: any) => p.payload_text).join(''))
      payload.source_run_id = `derived-context-${i}`
      payload.content.upstream_allocation_context_snapshot_id = formal.snapshot_id
      const raw = JSON.stringify(payload)
      manifest.source_run_id = payload.source_run_id
      manifest.snapshot_id = createHash('sha256').update(JSON.stringify([
        'allocation_context', manifest.signal_date, payload.source_run_id])).digest('hex')
      manifest.payload_checksum = createHash('sha256').update(raw).digest('hex')
      manifest.part_count = 1
      manifest.frozen_at = new Date(Date.parse(manifest.frozen_at) + 500).toISOString()
      value.tables.paired_nav_frozen_parts_v1.rows = [{ snapshot_id: manifest.snapshot_id, part_no: 0, payload_text: raw }]
      return value
    })
    const result = await setup(t, [formal, ...derived]).request()
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.control.snapshot_id, formal.snapshot_id)
  })
  for (const fault of ['ml', 'config']) {
    test(`serving ${fault} change during control readback cannot close`, async t => {
      const f = setup(t, [original.variants[0]])
      f.race(() => {
        if (fault === 'ml') f.sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run('e'.repeat(64))
        else {
          const config = JSON.parse(f.values.get('trading:config')!)
          config.position.maxPctOfPortfolio = .125
          f.values.set('trading:config', JSON.stringify(config))
        }
      })
      const result = await f.request()
      assert.equal(result.success, false, JSON.stringify(result))
      assert.equal(result.control_activation_verified, false)
      assert.equal(result.status, 'incomplete')
    })
  }
  for (const mutation of ['hash', 'missing_source', 'future_source', 'false_success', 'missing_result']) {
    test(`reject ${mutation} without turning it into normal pending`, async t => {
      const variant = structuredClone(original.variants[0])
      const manifest = variant.tables.paired_nav_frozen_manifests_v1.rows[0]
      const parts = variant.tables.paired_nav_frozen_parts_v1.rows.sort((a: any, b: any) => a.part_no - b.part_no)
      const payload = JSON.parse(parts.map((p: any) => p.payload_text).join(''))
      if (mutation === 'missing_source') delete payload.content.inputs.nav_control_context
      if (mutation === 'future_source') payload.content.inputs.nav_control_context.observed_at = '2099-01-01T00:00:00Z'
      if (mutation === 'false_success') payload.content.capture.opb_packet.status = 'error'
      if (mutation === 'missing_result') delete payload.content.opb_control_execution
      const raw = JSON.stringify(payload)
      variant.tables.paired_nav_frozen_parts_v1.rows = [{ snapshot_id: manifest.snapshot_id, part_no: 0, payload_text: raw }]
      manifest.part_count = 1
      manifest.payload_checksum = mutation === 'hash' ? 'a'.repeat(64) : createHash('sha256').update(raw).digest('hex')
      const result = await setup(t, [variant]).request()
      assert.equal(result.success, false, JSON.stringify(result))
      assert.equal(result.status, 'incomplete')
      assert.equal(result.control_activation_verified, false)
      assert.match(result.reason, /^opb_nav_control_/)
    })
  }
  test.after(() => fs.writeFileSync(source + '.responses.json', JSON.stringify(responses)))
}
