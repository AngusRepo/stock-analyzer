/** Original L3 -> EV NAV review -> original EV transaction -> L3 consumers. NOT ROI. */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { commitExpectedReturnChampion, hydrateExpectedReturnConfigFromPointers } from './expectedReturnServingRegistry'
import { buildExpectedReturnOwnerPromotionPlan } from './expectedReturnArtifactPromotion'
import { verifyNavPromotionEvidence } from './pairedNavPromotionEvidence'
import { inspectExpectedReturnComparison } from './expectedReturnComparison'

const source = process.env.NAV_L3_EV_FIXTURE
if (source) test('L3 remains usable after genuinely committed EV projections', async t => {
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
    catch (error) { sql.exec('ROLLBACK'); throw error }
  } }
  const current = structuredClone(f.current)
  const readCurrent = async () => ({ tradingConfig: structuredClone(current.trading_config), riskConfig: structuredClone(current.risk_config) })
  const bridge = (mode: string, formal?: any, readFault?: string) => {
    const result = spawnSync(f.python, ['tests/nav_l3_opb_bridge.py'], { cwd: path.resolve('../ml-controller'),
      input: JSON.stringify({ mode, formal, readFault, database: f.database, now: f.now, current }), encoding: 'utf8',
      env: process.env, timeout: 60000 })
    assert.equal(result.status, 0, String(result.error ?? '') + result.stdout + result.stderr)
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
  const evidence = () => sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'paired_nav_%' ORDER BY name").all()
    .map(row => [row.name, sql.prepare(`SELECT * FROM ${row.name}`).all()])
  const originalEvidence = evidence()
  const publications: any[] = []
  assert.equal(bridge('serving').eligible_model_count, 8)
  for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion'] as const) {
    const p = f.payloads[owner]
    const proof = await verifyNavPromotionEvidence(db, { owner, artifactId: p.artifact_id,
      artifactChecksum: p.artifact_checksum, gate: p.prospective_validation })
    const plan = buildExpectedReturnOwnerPromotionPlan(current.trading_config, owner, p, proof)
    assert.equal(plan.eligible, true, JSON.stringify(plan.blockers))
    const input = { owner, artifact: plan.serving_artifact!,
      artifactId: p.artifact_id, artifactPath: p.artifact_path, artifactChecksum: p.artifact_checksum,
      promotionPacketId: 'original-local-handoff', candidateId: plan.candidate_id,
      sourceRunDate: p.source_run_date, prospectiveValidation: p.prospective_validation,
      offlineAdmission: p.offline_admission, currentConfigReader: readCurrent, navBindings: env }
    if (owner === 'l4_alpha_ev') {
      const fusion = f.payloads.allocator_ev_fusion
      const fusionProof = await verifyNavPromotionEvidence(db, { owner: 'allocator_ev_fusion',
        artifactId: fusion.artifact_id, artifactChecksum: fusion.artifact_checksum,
        gate: fusion.prospective_validation })
      // Build the same prospective projection as the original ordered batch;
      // no L4 pointer exists yet and no plan is treated as publication.
      const fusionPlan = buildExpectedReturnOwnerPromotionPlan(plan.next_config, 'allocator_ev_fusion', fusion, fusionProof)
      assert.equal(fusionPlan.eligible, true, JSON.stringify(fusionPlan.blockers))
      const fusionInput = { ...input, owner: 'allocator_ev_fusion' as const, artifact: fusionPlan.serving_artifact!,
        artifactId: fusion.artifact_id, artifactPath: fusion.artifact_path, artifactChecksum: fusion.artifact_checksum,
        sourceRunDate: fusion.source_run_date, prospectiveValidation: fusion.prospective_validation,
        offlineAdmission: fusion.offline_admission }
      const beforeWait = sql.prepare('SELECT total_changes() n').get()?.n
      await assert.rejects(commitExpectedReturnChampion(db, fusionInput), /exact_l4_dependency_changed/)
      const wait = await inspectExpectedReturnComparison(db, fusionInput)
      assert.equal(wait?.state, 'awaiting_dependency')
      assert.equal(wait?.reason, 'exact_l4_dependency_not_serving')
      assert.deepEqual(wait?.changed_fields, ['l4_dependency'])
      assert.equal(wait?.nav_maturity_credit, 0)
      assert.equal(sql.prepare('SELECT total_changes() n').get()?.n, beforeWait)
    } else {
      // Exact L4 now serves: reuse the ORIGINAL Fusion evidence. A dependency
      // wait must not restart its clock or invent a new statistical gate.
      assert.equal(await inspectExpectedReturnComparison(db, input), null)
    }
    const receipt = await commitExpectedReturnChampion(db, input)
    publications.push({ input, receipt })
    assert.equal(receipt.artifact_id, p.artifact_id)
    current.trading_config = (await hydrateExpectedReturnConfigFromPointers(db, current.trading_config)).config
    assert.equal(bridge('serving').eligible_model_count, 8, owner + ' projection must preserve original L3 authority')
  }
  assert.deepEqual({ ...sql.prepare('SELECT * FROM active8_ensemble_pointer_v1').get() }, f.l3_pointer)
  assert.deepEqual(sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), reviews)
  f.now = '2026-10-07T14:00:00+00:00'
  assert.equal(bridge('serving').eligible_model_count, 8)
  for (const [name, change] of [
    ['risk', () => { current.risk_config.system.killSwitch = !current.risk_config.system.killSwitch }],
    ['sizing', () => { current.trading_config.position.maxPctOfPortfolio = .125 }],
    ['allocator source', () => { current.allocator_source_identity.changed = true }],
    ['native policy', () => { current.native_execution_policy.account_id += 1 }],
    ['unapproved controller', () => { current.trading_config.alphaFramework.allocation.controller = 'Unapproved' }],
    ['EV alias mismatch', () => { current.trading_config.ensemble_v2.l4AlphaEv.model_version = 'not-published' }],
  ] as const) await t.test(`reject changed ${name}`, () => {
    const saved = structuredClone(current)
    try { change(); assert.throws(() => bridge('serving'), /active8_nav_/) }
    finally { for (const key of Object.keys(current)) delete current[key]; Object.assign(current, saved) }
  })
  for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion']) {
    for (const [table, key, field, value] of [
      ['model_champion_pointers', 'model_name', 'champion_version', 'wrong'],
      ['model_champion_history', 'event_id', 'evidence_json', '{}'],
      ['model_artifact_registry', 'artifact_id', 'state', 'archived'],
      ['expected_return_artifact_payloads', 'artifact_id', 'artifact_json', '{}'],
      ['expected_return_owner_state_v2', 'owner', 'owner_state', 'safe_abstention'],
    ]) await t.test(`reject ${owner} ${table} corruption`, () => {
      const ownerColumn = table === 'expected_return_owner_state_v2' ? 'owner' : 'model_name'
      const rows = sql.prepare(`SELECT * FROM ${table} WHERE ${ownerColumn}=?`).all(owner)
      assert.ok(rows.length > 0)
      try {
        if (table === 'expected_return_owner_state_v2') {
          sql.prepare(`UPDATE ${table} SET owner_state=?,champion_artifact_id=NULL WHERE owner=?`).run(value, owner)
        } else sql.prepare(`UPDATE ${table} SET ${field}=? WHERE ${ownerColumn}=?`).run(value, owner)
        assert.throws(() => bridge('serving'), /active8_nav_/)
      } finally {
        for (const row of rows) {
          if (table === 'expected_return_owner_state_v2') {
            sql.prepare(`UPDATE ${table} SET owner_state=?,champion_artifact_id=? WHERE owner=?`)
              .run(row.owner_state, row.champion_artifact_id, row.owner)
          } else sql.prepare(`UPDATE ${table} SET ${field}=? WHERE ${key}=?`).run(row[field], row[key])
        }
      }
    })
  }
  await t.test('reject mixed EV source read', () => {
    assert.throws(() => bridge('serving', undefined, 'ev_state_after_first_read'), /source_changed_during_read/)
  })
  const beforeRetry = sql.prepare('SELECT total_changes() n').get()?.n
  for (const { input, receipt } of publications) {
    assert.deepEqual(await commitExpectedReturnChampion(db,
      { ...input, prospectiveValidation: { decision: 'HOLD' } }), receipt)
  }
  assert.equal(sql.prepare('SELECT total_changes() n').get()?.n, beforeRetry)
  assert.equal(bridge('serving').eligible_model_count, 8)
  assert.deepEqual(evidence(), originalEvidence)
  assert.deepEqual({ ...sql.prepare('SELECT * FROM active8_ensemble_pointer_v1').get() }, f.l3_pointer)
})
else test('original L3 and EV handoff fixture is supplied by Python', () => {
  const python = process.env.NAV_TEST_PYTHON ?? path.resolve('../../ml-service/.venv/Scripts/python.exe')
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: process.env.PYTHONPATH ?? path.resolve('../.tmp/nav-controller-runtime-deps') }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(python, ['-m', 'pytest', 'tests/test_nav_l3_ev_handoff.py', '-q', '--tb=short'],
    { cwd: path.resolve('../ml-controller'), env, encoding: 'utf8', timeout: 240000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
