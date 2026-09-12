/** Driven by test_nav_candidate_decision: real Python/SQLite/allocator ledger.
 * Deliberately no hand-authored statistical PASS or production connections.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { verifyNavPromotionEvidence, hasVerifiedNavPromotion } from './pairedNavPromotionEvidence'
import { buildExpectedReturnOwnerPromotionPlan } from './expectedReturnArtifactPromotion'
import { commitExpectedReturnChampion } from './expectedReturnServingRegistry'

const source = process.env.NAV_ORIGINAL_FIXTURE
if (!source) {
  test('build and verify original NAV through Python and nested Worker integration', () => {
    const localPython = path.resolve('../../ml-service/.venv/Scripts/python.exe')
    const python = process.env.NAV_TEST_PYTHON ?? (fs.existsSync(localPython) ? localPython : 'python')
    // Do not leak the outer Node runner's IPC context into a fresh nested
    // runner. Its failed assertions must become the Python subprocess status.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    delete childEnv.NODE_TEST_CONTEXT
    const result = spawnSync(python, ['-m', 'pytest', 'tests/test_nav_candidate_decision.py',
      '-q', '-p', 'no:cacheprovider', '--tb=short'], { cwd: path.resolve('../ml-controller'),
      env: childEnv, encoding: 'utf-8', timeout: 120000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
} else {
const original = JSON.parse(fs.readFileSync(source, 'utf8'))
function database(data: any): D1Database {
  return { prepare(sql: string) {
    let params: any[] = []
    const rows = () => {
      const table = /FROM\s+(\w+)/.exec(sql)?.[1]
      if (table === 'active8_ensemble_pointer_v1') {
        const { schema_version, ...formal } = fixtureConfig().formal_baseline_identity
        return [{ ...formal, validation_decision: 'PASS' }]
      }
      if (table === 'model_champion_pointers') return []
      if (table === 'paired_nav_daily_journal_v1') {
        const journals = data.tables[table].filter((r: any) => r.pair_id === params[0])
          .sort((a: any, b: any) => a.session_date < b.session_date ? -1 : 1)
        const last = journals.at(-1)
        return [{ accounted_sessions: journals.length, last_session_date: last?.session_date ?? null,
          last_journal_checksum: last?.payload_checksum ?? null }]
      }
      assert(table && data.tables[table], `unexpected SQL: ${sql}`)
      return data.tables[table].filter((r: any) => table === 'model_artifact_registry'
        ? r.artifact_id === params[0] && (sql.includes('AND checksum=?')
          ? r.checksum === params[1] : r.model_name === params[1] && r.version === params[2])
        : table.startsWith('paired_nav_frozen_') ? r.snapshot_id === params[0] : r.record_id === params[0])
        .sort((a: any, b: any) => a.part_no - b.part_no)
    }
    return { bind(...args: any[]) { params = args; return this },
      async first() { return rows()[0] ?? null }, async all() { return { results: rows() } } }
  } } as unknown as D1Database
}
function fixtureConfig(owner = 'l4_alpha_ev') {
  const id = original.payloads[owner].prospective_validation.nav_validation.allocation_snapshot_id
  const parts = original.tables.paired_nav_frozen_parts_v1.filter((p: any) => p.snapshot_id === id)
    .sort((a: any, b: any) => a.part_no - b.part_no)
  return JSON.parse(parts.map((p: any) => p.payload_text).join('')).content.configuration
}
const currentConfigReader = async () => ({ tradingConfig: fixtureConfig().trading_config, riskConfig: fixtureConfig().risk_config })
function input(data: any, owner = 'l4_alpha_ev') {
  const p = data.payloads[owner]
  return { owner, artifactId: p.artifact_id, artifactChecksum: p.artifact_checksum, gate: p.prospective_validation }
}
for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion']) {
  test(`${owner}: verifies original recorded NAV without requiring old corr/top gates`, async () => {
    const i = input(original, owner)
    assert.notEqual(i.gate.cross_section_diagnostic.decision, 'PASS')
    const proof = await verifyNavPromotionEvidence(database(original), i, new Date(original.now))
    assert(hasVerifiedNavPromotion(proof, owner, i.artifactId, i.artifactChecksum, i.gate))
    assert(!hasVerifiedNavPromotion({ ...proof }, owner, i.artifactId, i.artifactChecksum, i.gate))
    assert(!hasVerifiedNavPromotion(proof, owner, i.artifactId, 'f'.repeat(64), i.gate))
  })
}
for (const [name, mutate, expected] of [
  ['caller PASS changed', (d: any) => { d.payloads.l4_alpha_ev.prospective_validation.nav_validation.mean_daily_nav_delta = 99 }, /decision_checksum_mismatch/],
  ['registry mismatch', (d: any) => { d.tables.model_artifact_registry[0].live_evidence_json = '{}' }, /registry_gate_mismatch/],
  ['missing review part', (d: any) => { d.tables.paired_nav_review_parts_v1 = [] }, /record_parts_incomplete/],
  ['changed original bytes', (d: any) => { for (const r of d.tables.paired_nav_review_parts_v1) r.payload_text += ' ' }, /record_checksum_mismatch/],
  ['future record', (d: any) => { for (const r of d.tables.paired_nav_review_records_v1) r.created_at = '2099-01-01T00:00:00Z' }, /record_header_invalid/],
  ['future allocation seal', (d: any) => { for (const r of d.tables.paired_nav_frozen_manifests_v1) r.frozen_at = '2099-01-01T00:00:00Z' }, /allocation_manifest_mismatch/],
  ['invalid allocation seal', (d: any) => { for (const r of d.tables.paired_nav_frozen_manifests_v1) r.frozen_at = 'not-a-time' }, /allocation_manifest_mismatch/],
  ['timezone-free allocation seal', (d: any) => { for (const r of d.tables.paired_nav_frozen_manifests_v1) r.frozen_at = '2026-09-07T14:00:00' }, /allocation_manifest_mismatch/],
] as const) {
  test(name, async () => {
    const data = structuredClone(original)
    mutate(data)
    await assert.rejects(verifyNavPromotionEvidence(database(data), input(data), new Date(original.now)), expected)
  })
}
test('future business date cannot be accepted before its session exists', async () => {
  await assert.rejects(verifyNavPromotionEvidence(database(original), input(original), new Date('2026-09-09T14:00:00Z')),
    /decision_date_invalid/)
})

test('actual pointer consumer re-verifies originals before its transaction; forged gate cannot reach it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(original.now) })
  const data = structuredClone(original)
  const db = database(data)
  let transactions = 0
  db.batch = async () => { transactions++; throw new Error('fixture_before_any_pointer_write') }
  const p = data.payloads.l4_alpha_ev
  const input = { owner: 'l4_alpha_ev' as const, artifact: p.artifact, artifactId: p.artifact_id,
    artifactPath: p.artifact_path, artifactChecksum: p.artifact_checksum,
    promotionPacketId: 'isolated-fixture', candidateId: 'isolated-fixture', sourceRunDate: p.source_run_date,
    prospectiveValidation: p.prospective_validation, offlineAdmission: p.offline_admission, currentConfigReader }
  await assert.rejects(commitExpectedReturnChampion(db, input), /fixture_before_any_pointer_write/)
  assert.equal(transactions, 1)
  const bad = { ...input, prospectiveValidation: structuredClone(input.prospectiveValidation) }
  bad.prospectiveValidation.nav_validation.mean_daily_nav_delta = 99
  // Even changing the mutable registry to match the HTTP payload cannot alter
  // the immutable decision / review. No pointer transaction is attempted.
  data.tables.model_artifact_registry.find((r: any) => r.artifact_id === p.artifact_id).live_evidence_json = JSON.stringify(bad.prospectiveValidation)
  await assert.rejects(commitExpectedReturnChampion(db, bad), /decision_checksum_mismatch/)
  assert.equal(transactions, 1)
})

test('original NAV to actual SQLite pointer transaction: rollback, retry, no duplicate history or ledger changes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(original.now) })
  const sql = new DatabaseSync(':memory:')
  t.after(() => sql.close())
  sql.exec(fs.readFileSync('domain-migrations/learning/0044_paired_nav_review_records.sql', 'utf8'))
  sql.exec(fs.readFileSync('domain-migrations/learning/0040_paired_nav_shadow_journal.sql', 'utf8'))
  sql.exec(original.registry_schema)
  sql.exec(`ALTER TABLE model_artifact_registry ADD COLUMN approval_state TEXT;
    CREATE TABLE expected_return_artifact_payloads(artifact_id TEXT PRIMARY KEY, model_name TEXT,
      model_version TEXT, serving_mode TEXT, artifact_json TEXT, payload_checksum TEXT,
      source_artifact_path TEXT, source_artifact_checksum TEXT, source_cohort_id TEXT, updated_at TEXT);
    CREATE TABLE model_champion_pointers(model_name TEXT PRIMARY KEY, champion_version TEXT,
      champion_artifact_id TEXT, rollback_version TEXT, rollback_artifact_id TEXT, promoted_at TEXT,
      promotion_reason TEXT, promotion_evidence_json TEXT, updated_at TEXT);
    CREATE TABLE expected_return_owner_state_v2(owner TEXT PRIMARY KEY, owner_state TEXT,
      champion_artifact_id TEXT, reason_code TEXT, contract_manifest_version TEXT, updated_at TEXT);
    CREATE TABLE model_champion_history(event_id TEXT PRIMARY KEY, model_name TEXT, version TEXT,
      artifact_id TEXT, effective_at TEXT, retired_at TEXT, source TEXT, evidence_grade TEXT, evidence_json TEXT);
    CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY, artifact_id TEXT, cohort_id TEXT,
      payload_checksum TEXT,base_artifact_set_checksum TEXT);
    CREATE TABLE active8_ensemble_artifacts_v1(artifact_id TEXT PRIMARY KEY,cohort_id TEXT,payload_checksum TEXT,
      base_artifact_set_checksum TEXT,validation_decision TEXT,state TEXT,production_effect INTEGER);`)
  const formal = fixtureConfig().formal_baseline_identity
  sql.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)').run(formal.artifact_id,formal.cohort_id,formal.payload_checksum,formal.base_artifact_set_checksum)
  sql.prepare("INSERT INTO active8_ensemble_artifacts_v1 VALUES(?,?,?,?,'PASS','production',1)").run(formal.artifact_id,formal.cohort_id,formal.payload_checksum,formal.base_artifact_set_checksum)
  for (const table of ['model_artifact_registry', 'paired_nav_review_records_v1', 'paired_nav_review_parts_v1',
    'paired_nav_frozen_manifests_v1', 'paired_nav_frozen_parts_v1', 'paired_nav_daily_journal_v1']) {
    for (const row of original.tables[table]) {
      const names = Object.keys(row)
      sql.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`).run(...Object.values(row) as any[])
    }
  }
  class Statement {
    constructor(readonly text: string, readonly values: any[] = []) {}
    bind(...values: any[]) { return new Statement(this.text, values) }
    async first() { return sql.prepare(this.text).get(...this.values) ?? null }
    async all() { return { results: sql.prepare(this.text).all(...this.values) } }
    async run() { return { success: true, meta: sql.prepare(this.text).run(...this.values) } }
  }
  let interruptAt: number | null = null
  let race: (() => void) | null = null
  const db = { prepare: (text: string) => new Statement(text), async batch(statements: Statement[]) {
    race?.()
    sql.exec('BEGIN')
    try {
      const result = statements.map((s, index) => {
        const meta = sql.prepare(s.text).run(...s.values)
        if (index === interruptAt) throw new Error('fixture_interrupted_transaction')
        return { success: true, meta }
      })
      sql.exec('COMMIT')
      return result
    } catch (e) { sql.exec('ROLLBACK'); throw e }
  } } as unknown as D1Database
  const before = sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()
  const journalsBefore = sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all()
  const recoveryResponses: any[] = []
  const comparisonResponses: any[] = []
  let plannerConfig = {}
  for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion'] as const) {
    const p = original.payloads[owner]
    const proof = await verifyNavPromotionEvidence(db, {
      owner, artifactId: p.artifact_id, artifactChecksum: p.artifact_checksum,
      gate: p.prospective_validation,
    }, new Date(original.now))
    const plan = buildExpectedReturnOwnerPromotionPlan(plannerConfig, owner, p, proof)
    assert.equal(plan.eligible, true, plan.blockers.join(','))
    plannerConfig = plan.next_config
    // Match the real HTTP caller: commit the planner's serving projection,
    // never the raw offline candidate with non-serving flags.
    const input = { owner, artifact: plan.serving_artifact!, artifactId: p.artifact_id, artifactPath: p.artifact_path,
      artifactChecksum: p.artifact_checksum, candidateId: `fixture:${owner}`, promotionPacketId: `fixture:${owner}`,
      sourceRunDate: p.source_run_date, prospectiveValidation: p.prospective_validation, offlineAdmission: p.offline_admission,
      currentConfigReader }
    await t.test(`${owner}: changed comparison is waiting without publication or writes`, async () => {
      const { adminConfigCoreRoutes } = await import('../routes/adminConfigCoreRoutes')
      const { DEFAULT_TRADING_CONFIG } = await import('./tradingConfig')
      const values: Record<string, any> = {
        'trading:config': { ...structuredClone(DEFAULT_TRADING_CONFIG), ...fixtureConfig(owner).trading_config },
        'trading:risk_config': { ...fixtureConfig(owner).risk_config, maxSingleNamePct: .20 },
      }
      const kv = { async get(key: string, type: string) {
        return values[key] === undefined ? null : type === 'json' ? structuredClone(values[key]) : JSON.stringify(values[key])
      }, async put() { assert.fail('comparison observation must not write KV') } }
      const writes = sql.prepare('SELECT total_changes() n').get()!.n
      const response = await (await adminConfigCoreRoutes.request('/api/admin/config/expected-return/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-local-token' },
        body: JSON.stringify({ [owner]: p }),
      }, { DB: db, KV: kv, STOCKVISION_AUTH_TOKEN: 'fixture-local-token' } as any)).json() as any
      const outcome = response.outcomes?.[owner]
      assert.equal(outcome?.status, 'waiting', JSON.stringify(response))
      assert.equal(outcome.promoted, false)
      assert.equal(outcome.comparison.nav_maturity_credit, 0)
      assert(outcome.comparison.changed_fields.includes('risk_config'))
      assert.equal(sql.prepare('SELECT total_changes() n').get()!.n, writes)
      comparisonResponses.push({ owner, response })
      if (owner === 'l4_alpha_ev') {
        const batch = await (await adminConfigCoreRoutes.request('/api/admin/config/expected-return/promote', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-local-token' },
          body: JSON.stringify(original.payloads),
        }, { DB: db, KV: kv, STOCKVISION_AUTH_TOKEN: 'fixture-local-token' } as any)).json() as any
        assert.equal(batch.processing_complete, true, JSON.stringify(batch))
        assert.equal(batch.success, false)
        assert.deepEqual(batch.promoted_owners, [])
        for (const result of Object.values(batch.outcomes) as any[]) assert.equal(result.status, 'waiting')
        assert.equal(sql.prepare('SELECT total_changes() n').get()!.n, writes)
        fs.writeFileSync(`${source}.http-comparison-batch.json`, JSON.stringify(batch))
      }
    })
    await t.test(`${owner}: missing, corrupt, or racing current source is never observation waiting`, async () => {
      const { inspectExpectedReturnComparison } = await import('./expectedReturnComparison')
      const { hydrateExpectedReturnConfigFromPointers } = await import('./expectedReturnServingRegistry')
      const { DEFAULT_TRADING_CONFIG } = await import('./tradingConfig')
      const read = async () => ({ tradingConfig: (await hydrateExpectedReturnConfigFromPointers(db,
        { ...structuredClone(DEFAULT_TRADING_CONFIG), ...fixtureConfig(owner).trading_config })).config,
        riskConfig: { ...fixtureConfig(owner).risk_config, maxSingleNamePct: .20 } })
      const observationInput = { ...input, currentConfigReader: read }
      assert.equal((await inspectExpectedReturnComparison(db, observationInput))?.state, 'baseline_changed')
      const writes = sql.prepare('SELECT total_changes() n').get()!.n
      await assert.rejects(inspectExpectedReturnComparison(db, { ...observationInput,
        currentConfigReader: async () => ({ ...(await read()), riskConfig: {} }) }), /config_missing/)
      let reads = 0
      await assert.rejects(inspectExpectedReturnComparison(db, { ...observationInput,
        currentConfigReader: async () => ({ ...(await read()), riskConfig: { maxSingleNamePct: ++reads / 10 } }) }),
        /source_changed_during_read/)
      assert.equal(sql.prepare('SELECT total_changes() n').get()!.n, writes)
      // Private in-memory fixture savepoint; no database owner or production writes.
      sql.exec('SAVEPOINT comparison_invalid_source')
      try {
        sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run('f'.repeat(64))
        await assert.rejects(inspectExpectedReturnComparison(db, observationInput), /current_ml_baseline_changed/)
      } finally { sql.exec('ROLLBACK TO comparison_invalid_source; RELEASE comparison_invalid_source') }
      sql.exec('SAVEPOINT comparison_missing_schema')
      try {
        sql.exec('DROP TABLE expected_return_artifact_payloads')
        await assert.rejects(inspectExpectedReturnComparison(db, observationInput), /serving_source_invalid/)
      } finally { sql.exec('ROLLBACK TO comparison_missing_schema; RELEASE comparison_missing_schema') }
      if (owner === 'allocator_ev_fusion') {
        sql.exec('SAVEPOINT comparison_invalid_dependency')
        try {
          sql.prepare("UPDATE expected_return_artifact_payloads SET serving_mode='diagnostic' WHERE model_name='l4_alpha_ev'").run()
          await assert.rejects(inspectExpectedReturnComparison(db, observationInput), /serving_source_invalid/)
        } finally { sql.exec('ROLLBACK TO comparison_invalid_dependency; RELEASE comparison_invalid_dependency') }
      }
    })
    if (owner === 'l4_alpha_ev') {
      await assert.rejects(commitExpectedReturnChampion(db, { ...input, currentConfigReader: async () => ({
        ...(await currentConfigReader()), riskConfig: { ...fixtureConfig().risk_config, maxSingleNamePct: .1 } }) }),
        /current_configuration_changed/)
      sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run('f'.repeat(64))
      await assert.rejects(commitExpectedReturnChampion(db, input), /current_ml_baseline_changed/)
      sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run(formal.payload_checksum)
      race = () => { sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run('f'.repeat(64)) }
      await assert.rejects(commitExpectedReturnChampion(db, input), /malformed JSON/)
      assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers').get()?.n, 0)
      sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run(formal.payload_checksum)
      race = null
      race = () => { sql.prepare('INSERT INTO model_champion_pointers(model_name,champion_artifact_id) VALUES(?,?)').run(owner,'concurrent-incumbent') }
      await assert.rejects(commitExpectedReturnChampion(db, input), /malformed JSON/)
      assert.equal(sql.prepare('SELECT champion_artifact_id FROM model_champion_pointers WHERE model_name=?').get(owner)?.champion_artifact_id, 'concurrent-incumbent')
      assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_champion_history').get()?.n, 0)
      sql.prepare('DELETE FROM model_champion_pointers WHERE model_name=?').run(owner)
      race = null
    } else {
      const l4id = original.payloads.l4_alpha_ev.artifact_id
      for (const mutate of [
        () => { sql.prepare("UPDATE model_artifact_registry SET state='archived' WHERE artifact_id=?").run(l4id) },
        () => { sql.prepare("UPDATE expected_return_artifact_payloads SET serving_mode='diagnostic' WHERE artifact_id=?").run(l4id) },
        () => { sql.prepare("UPDATE model_champion_pointers SET champion_artifact_id='different-l4' WHERE model_name='l4_alpha_ev'").run() },
      ]) {
        race = mutate
        await assert.rejects(commitExpectedReturnChampion(db, input), /malformed JSON/)
        assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers WHERE model_name=?').get(owner)?.n, 0)
        sql.prepare("UPDATE model_artifact_registry SET state='production' WHERE artifact_id=?").run(l4id)
        sql.prepare("UPDATE expected_return_artifact_payloads SET serving_mode='alpha' WHERE artifact_id=?").run(l4id)
        sql.prepare("UPDATE model_champion_pointers SET champion_artifact_id=? WHERE model_name='l4_alpha_ev'").run(l4id)
      }
      race = null
    }
    const transactionTables = ['expected_return_artifact_payloads', 'model_artifact_registry',
      'model_champion_pointers', 'expected_return_owner_state_v2', 'model_champion_history']
    const state = () => Object.fromEntries(transactionTables.map(table =>
      [table, sql.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]))
    const beforeTransaction = state()
    await assert.rejects(commitExpectedReturnChampion(db, { ...input,
      artifact: { ...input.artifact, expected_return_owner: 'incorrect-owner' } }), /payload_owner_mismatch/)
    assert.deepEqual(state(), beforeTransaction, 'invalid new payload must fail before any transaction')
    // Interrupt AFTER SQL writes too, not just after the new read-only guard.
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      interruptAt = index
      await assert.rejects(commitExpectedReturnChampion(db, input), /fixture_interrupted_transaction/)
      assert.deepEqual(state(), beforeTransaction, `partial writes survived rollback at statement ${index}`)
    }
    interruptAt = null
    const result = await commitExpectedReturnChampion(db, input)
    assert.equal(result.artifact_id, p.artifact_id)
    await commitExpectedReturnChampion(db, input)
    // A completed commit is an idempotent receipt, not a second promotion.
    // Later config changes must neither repeat writes nor block acknowledgment.
    await commitExpectedReturnChampion(db, { ...input, currentConfigReader: async () => {
      throw new Error('fixture_already_committed_must_not_repromote')
    } })
    await t.test(`${owner}: refreshed diagnostics return the original immutable commit`, async () => {
      const committedState = state()
      const refreshed = { ...input, artifact: { ...input.artifact,
        prospective_validation: { ...input.prospectiveValidation, diagnostic_refresh: 'later-review' } } }
      assert.deepEqual(await commitExpectedReturnChampion(db, refreshed), result)
      assert.deepEqual(state(), committedState)
    })
    await t.test(`${owner}: actual authenticated HTTP repairs projection even when today's gate is HOLD`, async () => {
      const { adminConfigCoreRoutes } = await import('../routes/adminConfigCoreRoutes')
      const { DEFAULT_TRADING_CONFIG } = await import('./tradingConfig')
      const values = new Map<string, string>([['trading:config', JSON.stringify(DEFAULT_TRADING_CONFIG)]])
      let writeMode: 'fail' | 'drop' | 'normal' = 'fail'
      let afterWrite: (() => void) | null = null
      let putCount = 0
      const kv = {
        async get(key: string, type: string) { const v = values.get(key); return v ? (type === 'json' ? JSON.parse(v) : v) : null },
        async put(key: string, value: string) {
          putCount++
          if (key === 'trading:config' && writeMode === 'fail') throw new Error('fixture_projection_unavailable')
          if (key === 'trading:config' && writeMode === 'drop') return
          values.set(key, value)
          if (key === 'trading:config') afterWrite?.()
        },
      }
      const gate = { decision: 'HOLD', reason: 'fixture_later_review_is_not_new_promotion' }
      sql.prepare('UPDATE model_artifact_registry SET live_evidence_json=? WHERE artifact_id=?')
        .run(JSON.stringify(gate), p.artifact_id)
      const unchanged = state()
      const request = (token: string) => adminConfigCoreRoutes.request('/api/admin/config/expected-return/promote', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [owner]: { ...p, prospective_validation: gate } }),
      }, { DB: db, KV: kv, STOCKVISION_AUTH_TOKEN: 'fixture-local-token' } as any)
      try {
        assert.equal((await request('incorrect')).status, 401)
        assert.equal(putCount, 0)
        const unauthorizedConfig = await adminConfigCoreRoutes.request('/api/admin/config', {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-local-token' },
          body: JSON.stringify({ meta: { source: 'fixture_opb_without_promotion_packet' } }),
        }, { DB: db, KV: kv, STOCKVISION_AUTH_TOKEN: 'fixture-local-token' } as any)
        assert.equal(unauthorizedConfig.status, 400)
        assert.equal((await unauthorizedConfig.json() as any).error, 'config_put_requires_promotion_packet_or_override')
        assert.equal(putCount, 0)
        const failed = await (await request('fixture-local-token')).json() as any
        assert.equal(failed.outcomes?.[owner]?.already_committed, true, JSON.stringify(failed))
        assert.match(failed.outcomes[owner].config_projection_error, /fixture_projection_unavailable/)
        assert.equal(failed.success, false)
        assert.equal(failed.status, 'incomplete')
        recoveryResponses.push({ owner, expected_complete: false, response: failed })
        writeMode = 'drop'
        const dropped = await (await request('fixture-local-token')).json() as any
        assert.equal(dropped.success, false)
        assert.match(dropped.outcomes[owner].config_projection_error, /projection_readback_mismatch/)
        recoveryResponses.push({ owner, expected_complete: false, response: dropped })
        writeMode = 'normal'
        afterWrite = () => { sql.prepare('UPDATE model_champion_pointers SET champion_artifact_id=? WHERE model_name=?')
          .run('fixture_concurrent_pointer', owner) }
        const raced = await (await request('fixture-local-token')).json() as any
        assert.equal(raced.success, false)
        assert.match(raced.outcomes[owner].config_projection_error, /projection_readback_mismatch/)
        recoveryResponses.push({ owner, expected_complete: false, response: raced })
        afterWrite = null
        sql.prepare('UPDATE model_champion_pointers SET champion_artifact_id=? WHERE model_name=?').run(p.artifact_id, owner)
        if (owner === 'allocator_ev_fusion') {
          const l4id = original.payloads.l4_alpha_ev.artifact_id
          afterWrite = () => { sql.prepare("UPDATE model_champion_pointers SET champion_artifact_id=? WHERE model_name='l4_alpha_ev'")
            .run('fixture_other_owner_changed') }
          const otherRace = await (await request('fixture-local-token')).json() as any
          assert.equal(otherRace.success, false)
          assert.match(otherRace.outcomes[owner].config_projection_error, /projection_readback_mismatch/)
          afterWrite = null
          sql.prepare("UPDATE model_champion_pointers SET champion_artifact_id=? WHERE model_name='l4_alpha_ev'").run(l4id)
        }
        const repaired = await (await request('fixture-local-token')).json() as any
        assert.equal(repaired.success, true)
        assert.equal(repaired.effective_owner, owner)
        assert.equal(repaired.outcomes[owner].pointer_commit.nav_review_date,
          p.prospective_validation.nav_validation.as_of_date)
        assert.equal(repaired.outcomes?.[owner]?.already_committed, true, JSON.stringify(repaired))
        assert.equal(repaired.outcomes[owner].config_projection_error, null)
        recoveryResponses.push({ owner, expected_complete: true, response: repaired })
        assert.deepEqual(repaired.outcomes[owner].pointer_commit, result)
        const config = JSON.parse(values.get('trading:config')!)
        const artifact = owner === 'l4_alpha_ev' ? config.ensemble_v2.l4AlphaEv : config.ensemble_v2.allocatorEvFusion
        assert.deepEqual(artifact, JSON.parse(String(sql.prepare(
          'SELECT artifact_json FROM expected_return_artifact_payloads WHERE artifact_id=?').get(p.artifact_id)?.artifact_json)))
        assert.deepEqual(state(), unchanged, 'repair must not rewrite registry, payload, pointer, owner or history')
        const writes = putCount
        sql.exec('SAVEPOINT damaged_projection')
        try {
          sql.prepare('UPDATE expected_return_artifact_payloads SET artifact_json=? WHERE artifact_id=?').run('{}', p.artifact_id)
          const corrupt = await (await request('fixture-local-token')).json() as any
          assert.equal(corrupt.success, false)
          assert.match(corrupt.outcomes[owner].blockers.join(','), /pointer_commit_readback_mismatch/)
          assert.equal(putCount, writes, 'damaged authority must not be copied to KV')
        } finally { sql.exec('ROLLBACK TO damaged_projection; RELEASE damaged_projection') }
      } finally {
        sql.prepare('UPDATE model_artifact_registry SET live_evidence_json=? WHERE artifact_id=?')
          .run(JSON.stringify(p.prospective_validation), p.artifact_id)
      }
    })
    for (const [name, statement, value] of [
      ['payload bytes', 'UPDATE expected_return_artifact_payloads SET artifact_json=? WHERE artifact_id=?', '{}'],
      ['payload checksum', 'UPDATE expected_return_artifact_payloads SET payload_checksum=? WHERE artifact_id=?', 'f'.repeat(64)],
      ['payload owner', 'UPDATE expected_return_artifact_payloads SET model_name=? WHERE artifact_id=?', 'another-owner'],
      ['payload version', 'UPDATE expected_return_artifact_payloads SET model_version=? WHERE artifact_id=?', 'another-version'],
      ['source path', 'UPDATE expected_return_artifact_payloads SET source_artifact_path=? WHERE artifact_id=?', 'another-path'],
      ['source checksum', 'UPDATE expected_return_artifact_payloads SET source_artifact_checksum=? WHERE artifact_id=?', 'f'.repeat(64)],
      ['registry state', 'UPDATE model_artifact_registry SET state=? WHERE artifact_id=?', 'archived'],
      ['history bytes', 'UPDATE model_champion_history SET evidence_json=? WHERE artifact_id=?', '{}'],
      ['retired history', 'UPDATE model_champion_history SET retired_at=? WHERE artifact_id=?', original.now],
      ['serving mode', 'UPDATE expected_return_artifact_payloads SET serving_mode=? WHERE artifact_id=?', 'diagnostic'],
    ]) {
      await t.test(`${owner}: committed recovery rejects corrupt ${name}`, async () => {
        const unchanged = state()
        sql.exec('SAVEPOINT corrupt_commit')
        try {
          sql.prepare(statement).run(value, p.artifact_id)
          await assert.rejects(commitExpectedReturnChampion(db, input), /pointer_commit_readback_mismatch/)
        } finally { sql.exec('ROLLBACK TO corrupt_commit; RELEASE corrupt_commit') }
        assert.deepEqual(state(), unchanged)
      })
    }
    const pointer = sql.prepare('SELECT * FROM model_champion_pointers WHERE model_name=?').get(owner)
    assert.equal(pointer?.champion_artifact_id, p.artifact_id)
    assert.equal(pointer?.rollback_artifact_id, null)
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM model_champion_history WHERE model_name=? AND retired_at IS NULL').get(owner)?.n, 1)
    assert.equal(sql.prepare('SELECT offline_gate_decision AS d FROM model_artifact_registry WHERE artifact_id=?').get(p.artifact_id)?.d, 'FAIL')
  }
  assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), before)
  assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all(), journalsBefore)
  fs.writeFileSync(`${source}.http-recovery.json`, JSON.stringify(recoveryResponses))
  fs.writeFileSync(`${source}.http-comparison.json`, JSON.stringify(comparisonResponses))
})

test('actual promotion planner uses original NAV for both owners, keeps parity and exact identities', async () => {
  let config = {}
  for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion'] as const) {
    const i = input(original, owner)
    const proof = await verifyNavPromotionEvidence(database(original), i, new Date(original.now))
    const candidate = original.payloads[owner]
    const unverified = buildExpectedReturnOwnerPromotionPlan(config, owner, candidate)
    assert.equal(unverified.eligible, false)
    assert(unverified.blockers.includes('nav_original_evidence_unverified'))
    const plan = buildExpectedReturnOwnerPromotionPlan(config, owner, candidate, proof)
    assert.equal(plan.eligible, true, plan.blockers.join(','))
    const broken = structuredClone(candidate)
    broken.operational_parity.owner_decisions[owner] = { decision: 'FAIL', failed_gates: ['feature_mismatch'] }
    assert.equal(buildExpectedReturnOwnerPromotionPlan(config, owner, broken, proof).eligible, false)
    const altered = structuredClone(candidate)
    altered.prospective_validation.evaluable_date_count = 99
    assert.equal(buildExpectedReturnOwnerPromotionPlan(config, owner, altered, proof).eligible, false)
    config = plan.next_config
  }
})
}
