/** Real Python ledger/review bytes and original SQLite schema; synthetic NOT ROI.
 * This verifies economic evidence, not permission to mutate production config.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { verifyNavPromotionEvidence, hasVerifiedNavPromotion, originalNavComparisonContext } from './pairedNavPromotionEvidence'
import { commitOpbNavChampion, readOpbNavCommitReceipt } from './opbNavPublication'
import { L4_ALPHA_EV_CONTRACT as L } from './evidenceContracts'

const source = process.env.NAV_OPB_ORIGINAL_FIXTURE
if (!source) {
  test('original ten-session OPB NAV -> Worker verifier', () => {
    const local = path.resolve('../../ml-service/.venv/Scripts/python.exe')
    const python = process.env.NAV_TEST_PYTHON ?? (fs.existsSync(local) ? local : 'python')
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' }
    delete env.NODE_TEST_CONTEXT
    const checked = spawnSync(python, ['-m', 'pytest', 'tests/test_nav_opb_daily_primary.py',
      '-k', 'original_ten_session', '-q', '--tb=short'], {
      cwd: path.resolve('../ml-controller'), env, encoding: 'utf-8', timeout: 120000 })
    assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  })
} else {
  const original = JSON.parse(fs.readFileSync(source, 'utf8'))
  function database(t: { after: (fn: () => void) => void }) {
    const sql = new DatabaseSync(':memory:')
    // D1 CURRENT_TIMESTAMP and the Worker clock share one simulated UTC clock.
    sql.function('current_timestamp', () => new Date(original.now).toISOString().replace('T', ' ').slice(0, 19))
    t.after(() => sql.close())
    for (const [table, schema] of Object.entries(original.schemas)) {
      sql.exec(String(schema))
      for (const row of original.tables[table]) {
        const fields = Object.keys(row)
        sql.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`)
          .run(...fields.map(k => row[k]))
      }
    }
    const db = { prepare(text: string) {
      const statement = sql.prepare(text)
      let params: any[] = []
      return { bind(...values: any[]) { params = values; return this },
        execute() { return statement.run(...params) },
        async first() { return statement.get(...params) ?? null },
        async all() { return { results: statement.all(...params) } } }
    } } as unknown as D1Database
    return { sql, db }
  }
  const input = () => ({ owner: 'opb_arm_prior', artifactId: original.payload.artifact_id,
    artifactChecksum: original.payload.artifact_checksum, gate: structuredClone(original.payload.prospective_validation) })
  function publication(t: { after: (fn: () => void) => void }) {
    const { sql, db } = database(t)
    const schema = fs.readFileSync('domain-schemas/learning.sql', 'utf8')
    for (const table of ['model_champion_pointers', 'model_champion_history', 'expected_return_artifact_payloads',
      'expected_return_owner_state_v2', 'expected_return_forward_guard_state',
      'active8_ensemble_pointer_v1', 'active8_ensemble_artifacts_v1']) {
      const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0]
      assert(ddl, `original schema missing: ${table}`)
      sql.exec(ddl)
    }
    const id = original.payload.prospective_validation.nav_validation.allocation_snapshot_id
    const parts = original.tables.paired_nav_frozen_parts_v1.filter((p: any) => p.snapshot_id === id)
      .sort((a: any, b: any) => a.part_no - b.part_no)
    const configuration = JSON.parse(parts.map((p: any) => p.payload_text).join('')).content.configuration
    const f = configuration.formal_baseline_identity
    sql.prepare(`INSERT INTO active8_ensemble_artifacts_v1(artifact_id,cohort_id,training_run_id,
      knowledge_cutoff_date,schema_version,payload_json,payload_checksum,base_artifact_set_checksum,
      validation_decision,validation_json,archive_uri,state,production_effect)
      VALUES(?,?,?,'2026-08-25','active8-oof-ensemble-serving-artifact-v1','{}',?,?,'PASS','{}','fixture://local','production',1)`)
      .run(f.artifact_id, f.cohort_id, f.cohort_id, f.payload_checksum, f.base_artifact_set_checksum)
    sql.prepare(`INSERT INTO active8_ensemble_pointer_v1(singleton_id,artifact_id,cohort_id,payload_checksum,
      base_artifact_set_checksum,promotion_reason) VALUES(1,?,?,?,?,'existing formal test fixture')`)
      .run(f.artifact_id, f.cohort_id, f.payload_checksum, f.base_artifact_set_checksum)
    const ev = configuration.opb_serving_ev_identity[0]
    const evId = `l4_alpha_ev:${ev.expected_return_model_version}:${'b'.repeat(64)}`
    const artifact = { expected_return_owner: 'l4_alpha_ev', model_version: ev.expected_return_model_version,
      trained_until: ev.expected_return_trained_until, output_is_net_of_costs: true,
      artifact_contract_version: L.artifactContractVersion, feature_semantic_version: L.featureSemanticVersion,
      label_schema_version: L.labelSchemaVersion, promotion_state: 'production_approved',
      validation_packet: { decision: 'PASS' } }
    const raw = JSON.stringify(artifact)
    sql.prepare(`INSERT INTO model_artifact_registry(artifact_id,model_name,version,candidate_type,state,checksum)
      VALUES(?,'l4_alpha_ev',?,'l4_alpha_ev_refresh','production',?)`).run(evId, artifact.model_version, 'b'.repeat(64))
    sql.prepare(`INSERT INTO model_champion_pointers(model_name,champion_version,champion_artifact_id)
      VALUES('l4_alpha_ev',?,?)`).run(artifact.model_version, evId)
    sql.prepare(`INSERT INTO expected_return_artifact_payloads(artifact_id,model_name,model_version,
      serving_mode,artifact_json,payload_checksum,source_artifact_checksum)
      VALUES(?,'l4_alpha_ev',?,'alpha',?,?,?)`).run(evId, artifact.model_version,
        raw, createHash('sha256').update(raw).digest('hex'), 'b'.repeat(64))
    sql.prepare(`INSERT INTO expected_return_owner_state_v2(owner,owner_state,champion_artifact_id,
      reason_code,contract_manifest_version) VALUES('l4_alpha_ev','learned_champion',?,'fixture','fixture')`).run(evId)
    // Explicit original owner-state baseline, not a fabricated Fusion champion.
    sql.prepare(`INSERT INTO expected_return_owner_state_v2(owner,owner_state,champion_artifact_id,
      reason_code,contract_manifest_version) VALUES('allocator_ev_fusion','safe_abstention',NULL,'fixture_not_promoted','fixture')`).run()
    let beforeBatch = () => {}, failAt = -1, batches = 0
    db.batch = async (statements: any[]) => {
      batches++
      beforeBatch()
      sql.exec('BEGIN')
      try {
        const results = statements.map((statement, index) => {
          if (index === failAt) throw new Error('fixture_transaction_interrupted')
          statement.execute()
          return { success: true, results: [], meta: {} }
        })
        sql.exec('COMMIT')
        return results as any
      } catch (error) { sql.exec('ROLLBACK'); throw error }
    }
    const current = { tradingConfig: configuration.trading_config, riskConfig: configuration.risk_config }
    const request = { ...input(), currentConfigReader: async () => structuredClone(current) }
    return { sql, db, request, current,
      before(fn: () => void) { beforeBatch = fn }, interrupt(index: number) { failAt = index },
      count: () => batches, commit: () => commitOpbNavChampion(db, request, new Date(original.now)) }
  }

  test('original NAV adopts exact OPB pointer and history atomically; retry does not spend or rewrite', async t => {
    const f = publication(t)
    const reviews = f.sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()
    const result = await f.commit()
    assert.equal(result.artifact_id, original.payload.artifact_id)
    assert.equal(result.evidence.gate.offline_diagnostic.decision, 'FAIL')
    assert.equal(f.sql.prepare("SELECT state FROM model_artifact_registry WHERE model_name='opb_arm_prior'").get()?.state, 'production')
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM model_champion_history WHERE model_name='opb_arm_prior'").get()?.n, 1)
    const changes = f.sql.prepare('SELECT total_changes() AS n').get()?.n
    assert.deepEqual(await f.commit(), result)
    assert.equal(f.count(), 1)
    assert.equal(f.sql.prepare('SELECT total_changes() AS n').get()?.n, changes)
    assert.deepEqual(f.sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), reviews)
    f.sql.prepare("UPDATE model_artifact_registry SET live_evidence_json='{}' WHERE model_name='opb_arm_prior'").run()
    f.request.gate = { decision: 'HOLD' }
    assert.deepEqual(await f.commit(), result) // exact committed recovery, no new qualification
  })

  test('fallback history reader uses the real original publication, not default parameters', async t => {
    const f = publication(t)
    const receipt = await f.commit()
    const { originalOpbFallbackControls } = await import('./opbNavRetirement')
    const controlled = structuredClone(f.current.tradingConfig)
    controlled.alphaFramework.allocation.controller = 'OnlinePortfolioBandit'
    controlled.alphaFramework.allocation.opbArmPrior = JSON.parse(receipt.evidence.gate.candidate_payload_json)
    const cutoff = Date.parse(original.now)
    const found = await originalOpbFallbackControls(f.db, controlled, cutoff)
    assert.equal(found.controls.controller, f.current.tradingConfig.alphaFramework.allocation.controller)
    assert.equal(found.history.length, 1)
    assert.equal(found.history[0].event_id,
      `opb-nav:${receipt.artifact_checksum}:${receipt.evidence.decision_checksum}`)
    assert.equal(found.history[0].evidence_checksum, receipt.payload_checksum)
    f.sql.exec("UPDATE model_champion_history SET evidence_json='{}' WHERE model_name='opb_arm_prior'")
    await assert.rejects(originalOpbFallbackControls(f.db, controlled, cutoff))
  })

  for (const mode of ['normal', 'interrupted', 'lost_ack', 'corrupt_ev', 'missing_ev_pointer',
    'ev_change', 'ev_abstention', 'ev_mode_race', 'ev_abstention_state_race'])
  test(`original published OPB retirement ${mode} preserves evidence and retries`, async t => {
    const f = publication(t)
    const { adminConfigCoreRoutes } = await import('../routes/adminConfigCoreRoutes')
    const Clock = globalThis.Date
    globalThis.Date = class extends Clock {
      constructor(value?: any) { super(value === undefined ? original.now : value) }
      static now() { return new Clock(original.now).getTime() }
    } as DateConstructor
    t.after(() => { globalThis.Date = Clock })
    const values = new Map([['trading:config', JSON.stringify(f.current.tradingConfig)],
      ['trading:risk_config', JSON.stringify(f.current.riskConfig)]])
    let puts = 0
    const kv = { async get(key: string, type: string) {
      const value = values.get(key); return value ? type === 'json' ? JSON.parse(value) : value : null
    }, async put(key: string, value: string) { puts++; values.set(key, value) } }
    const env = { DB: f.db, KV: kv, STOCKVISION_AUTH_TOKEN: 'local-fixture-token' } as any
    const request = async () => (await adminConfigCoreRoutes.request('/api/admin/config/opb/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-fixture-token' },
      body: JSON.stringify(original.payload),
    }, env)).json() as Promise<any>
    const before = f.sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()
    const journals = f.sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all()
    assert.equal((await request()).success, true)
    const controlled = JSON.parse(values.get('trading:config')!)
    assert.equal(controlled.alphaFramework.allocation.controller, 'OnlinePortfolioBandit')
    const changedRisk = { ...f.current.riskConfig, maxSingleNamePct: .20 }
    values.set('trading:risk_config', JSON.stringify(changedRisk))
    if (mode === 'corrupt_ev' || mode === 'missing_ev_pointer') {
      if (mode === 'corrupt_ev') f.sql.exec("UPDATE expected_return_artifact_payloads SET serving_mode='abstention_baseline'")
      else f.sql.exec("DELETE FROM model_champion_pointers WHERE model_name='l4_alpha_ev'")
      const writes = f.sql.prepare('SELECT total_changes() n').get()?.n, oldPuts = puts
      const refused = await request()
      assert.equal(refused.success, false)
      assert.match(refused.reason, /comparison_ev_source_invalid/)
      assert.equal(f.sql.prepare('SELECT total_changes() n').get()?.n, writes)
      assert.equal(puts, oldPuts)
      return
    }
    if (mode === 'ev_abstention' || mode === 'ev_abstention_state_race') {
      f.sql.exec("UPDATE expected_return_artifact_payloads SET serving_mode='abstention_baseline'")
      f.sql.exec("UPDATE expected_return_owner_state_v2 SET owner_state='safe_abstention',champion_artifact_id=NULL WHERE owner='l4_alpha_ev'")
      const { readOpbComparisonSource } = await import('./opbNavPublication')
      const { hydrateExpectedReturnConfigFromPointers } = await import('./expectedReturnServingRegistry')
      await assert.rejects(readOpbComparisonSource(f.db, async () => ({
        tradingConfig: (await hydrateExpectedReturnConfigFromPointers(f.db, controlled)).config,
        riskConfig: changedRisk,
      })), /comparison_ev_source_unavailable/, 'retirement must not relax candidate admission')
      if (mode === 'ev_abstention_state_race')
        f.sql.exec("DELETE FROM model_champion_pointers WHERE model_name='l4_alpha_ev'")
    }
    if (mode === 'ev_change') {
      // Coherent legacy registry source replacement, not fabricated NAV support
      // for a new EV. The OPB publication and its original evidence remain real.
      const r = f.sql.prepare("SELECT * FROM model_artifact_registry WHERE model_name='l4_alpha_ev'").get() as any
      const x = f.sql.prepare('SELECT * FROM expected_return_artifact_payloads WHERE artifact_id=?').get(r.artifact_id) as any
      const artifact = { ...JSON.parse(x.artifact_json), model_version: r.version + '-next' }
      const raw = JSON.stringify(artifact), checksum = createHash('sha256').update(raw).digest('hex')
      const id = `l4_alpha_ev:${artifact.model_version}:${checksum}`
      const insert = (table: string, row: any) => {
        const keys = Object.keys(row)
        f.sql.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
          .run(...keys.map(k => row[k]))
      }
      f.sql.prepare("UPDATE model_artifact_registry SET state='archived' WHERE artifact_id=?").run(r.artifact_id)
      insert('model_artifact_registry', { ...r, artifact_id: id, version: artifact.model_version, checksum })
      insert('expected_return_artifact_payloads', { ...x, artifact_id: id, model_version: artifact.model_version,
        artifact_json: raw, payload_checksum: checksum, source_artifact_checksum: checksum })
      f.sql.prepare("UPDATE model_champion_pointers SET champion_artifact_id=?,champion_version=? WHERE model_name='l4_alpha_ev'")
        .run(id, artifact.model_version)
      f.sql.prepare("UPDATE expected_return_owner_state_v2 SET champion_artifact_id=? WHERE owner='l4_alpha_ev'").run(id)
    }
    if (mode === 'interrupted') f.interrupt(2)
    if (mode === 'ev_mode_race' || mode === 'ev_abstention_state_race') {
      f.before(() => {
        if (mode === 'ev_mode_race')
          f.sql.exec("UPDATE expected_return_artifact_payloads SET serving_mode='abstention_baseline'")
        else f.sql.prepare("UPDATE expected_return_owner_state_v2 SET owner_state='learned_champion',champion_artifact_id=? WHERE owner='l4_alpha_ev'")
          .run('missing-fixture-champion')
      })
      const failed = await request()
      assert.equal(failed.success, false, JSON.stringify(failed))
      assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.n, 1)
      assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM model_champion_history WHERE model_name='opb_arm_prior' AND retired_at IS NULL").get()?.n, 1)
      assert.deepEqual(f.sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), before)
      assert.deepEqual(f.sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all(), journals)
      return
    }
    if (mode === 'lost_ack') {
      const batch = f.db.batch.bind(f.db)
      let lose = true
      ;(f.db as any).batch = async (statements: any[]) => {
        const result = await batch(statements)
        if (lose) { lose = false; throw new Error('fixture_retirement_commit_ack_lost') }
        return result
      }
    }
    if (['interrupted', 'lost_ack'].includes(mode)) {
      const failed = await request()
      assert.equal(failed.success, false, JSON.stringify(failed))
      const pointers = f.sql.prepare("SELECT COUNT(*) n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.n
      assert.equal(pointers, mode === 'interrupted' ? 1 : 0)
      if (mode === 'interrupted') f.interrupt(-1)
    }
    const retired = await request()
    assert.equal(retired.status, 'retired', JSON.stringify(retired))
    assert.equal(retired.pointer_committed, false)
    assert.equal(retired.control_activation_verified, false)
    assert.equal(retired.retirement.nav_maturity_credit, 0)
    const restored = JSON.parse(values.get('trading:config')!)
    assert.equal(restored.alphaFramework.allocation.controller, f.current.tradingConfig.alphaFramework.allocation.controller)
    if (mode === 'ev_change') {
      assert(restored.ensemble_v2.l4AlphaEv.model_version.endsWith('-next'))
      assert(retired.retirement.changed_fields.includes('serving_ev'))
    } else if (mode === 'ev_abstention') {
      assert.equal(restored.ensemble_v2.l4AlphaEv, undefined)
      assert.equal(restored.ensemble_v2.l4_alpha_ev, undefined)
      assert(retired.retirement.changed_fields.includes('serving_ev'))
    } else assert.deepEqual(restored.ensemble_v2, controlled.ensemble_v2)
    assert.deepEqual(JSON.parse(values.get('trading:risk_config')!), changedRisk)
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.n, 0)
    assert.equal(f.sql.prepare("SELECT state FROM model_artifact_registry WHERE model_name='opb_arm_prior'").get()?.state, 'shadowing')
    const writes = f.sql.prepare('SELECT total_changes() n').get()?.n, oldPuts = puts
    assert.deepEqual(await request(), retired)
    assert.equal(f.sql.prepare('SELECT total_changes() n').get()?.n, writes)
    assert.equal(puts, oldPuts)
    assert.deepEqual(f.sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), before)
    assert.deepEqual(f.sql.prepare('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date').all(), journals)
    if (mode === 'normal') {
      fs.writeFileSync(source + '.retirement.json', JSON.stringify(retired))
      const tables = Object.fromEntries(['model_artifact_registry', 'model_champion_pointers',
        'model_champion_history', 'expected_return_artifact_payloads', 'expected_return_owner_state_v2',
        'expected_return_forward_guard_state', 'active8_ensemble_pointer_v1', 'active8_ensemble_artifacts_v1']
        .map(table => [table, { schema: f.sql.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table)?.sql,
          rows: f.sql.prepare(`SELECT * FROM ${table}`).all() }]))
      fs.writeFileSync(source + '.retirement-state.json', JSON.stringify({ tables,
        trading_config: restored, risk_config: JSON.parse(values.get('trading:risk_config')!) }))
    }
  })
  test('unpublished stale comparison is a verified wait, not endless publication retry', async t => {
    const { adminConfigCoreRoutes } = await import('../routes/adminConfigCoreRoutes')
    const waits: any[] = []
    const OriginalDate = globalThis.Date
    globalThis.Date = class extends OriginalDate {
      constructor(value?: any) { super(value === undefined ? original.now : value) }
      static now() { return new OriginalDate(original.now).getTime() }
    } as DateConstructor
    try {
      for (const fault of ['changed_config', 'changed_ml', 'corrupt_ml', 'corrupt_ev', 'missing_review', 'racing_config']) {
        await t.test(fault, async t => {
          const f = publication(t)
          const config = structuredClone(f.current.tradingConfig)
          if (fault !== 'changed_ml') config.position.maxPctOfPortfolio = .125
          if (fault === 'changed_ml') {
            const replacement = '9'.repeat(64)
            f.sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run(replacement)
            f.sql.prepare('UPDATE active8_ensemble_artifacts_v1 SET payload_checksum=?').run(replacement)
          }
          if (fault === 'corrupt_ml') f.sql.prepare('UPDATE active8_ensemble_pointer_v1 SET payload_checksum=?').run('c'.repeat(64))
          if (fault === 'corrupt_ev') f.sql.exec("UPDATE expected_return_artifact_payloads SET artifact_json='{}'")
          if (fault === 'missing_review') f.sql.exec('DELETE FROM paired_nav_review_parts_v1')
          const before = f.sql.prepare('SELECT total_changes() n').get()?.n
          let reads = 0
          const values = new Map([['trading:config', JSON.stringify(config)],
            ['trading:risk_config', JSON.stringify(f.current.riskConfig)]])
          const kv = { async get(key: string, type: string) {
            if (key === 'trading:config' && fault === 'racing_config' && ++reads > 1) {
              const changed = structuredClone(config)
              changed.position.maxPctOfPortfolio = .15
              return type === 'json' ? changed : JSON.stringify(changed)
            }
            const raw = values.get(key)
            return raw ? type === 'json' ? JSON.parse(raw) : raw : null
          }, async put() { assert.fail('comparison observation cannot publish config') } }
          const env = { DB: { prepare() { assert.fail('wrong D1 owner') } }, LEARNING_DB: f.db,
            MULTI_D1_ACTIVE_DOMAINS: 'learning', MULTI_D1_STRICT: 'true', KV: kv,
            STOCKVISION_AUTH_TOKEN: 'local-fixture-token' } as any
          const response = await (await adminConfigCoreRoutes.request('/api/admin/config/opb/promote', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-fixture-token' },
            body: JSON.stringify({ artifact_id: input().artifactId, artifact_checksum: input().artifactChecksum,
              prospective_validation: input().gate }),
          }, env)).json() as any
          assert.equal(response.pointer_committed, false)
          assert.equal(response.control_activation_verified, false)
          assert.equal(f.sql.prepare('SELECT total_changes() n').get()?.n, before)
          if (fault.startsWith('changed_')) {
            assert.equal(response.status, 'waiting', JSON.stringify(response))
            assert.equal(response.completion_scope, 'candidate_comparison')
            assert.equal(response.comparison.decision_checksum, input().gate.nav_validation.decision_checksum)
            assert.equal(response.comparison.nav_maturity_credit, 0)
            assert.deepEqual(response.comparison.changed_fields,
              fault === 'changed_ml' ? ['formal_ml'] : ['trading_config'])
            waits.push(response)
          } else {
            assert.equal(response.status, 'incomplete', JSON.stringify(response))
            assert.equal(response.comparison, undefined)
          }
        })
      }
    } finally { globalThis.Date = OriginalDate }
    fs.writeFileSync(source + '.comparison-waits.json', JSON.stringify(waits))
  })
  test('OPB publication transaction rejects a changed journal anchor after verification', async t => {
    const f = publication(t)
    const head = input().gate.nav_validation.review_family_journal_frontier[0]
    // Deliberate corruption in this private fixture, not a fabricated NAV return.
    f.before(() => f.sql.prepare('UPDATE paired_nav_daily_journal_v1 SET payload_checksum=? WHERE pair_id=? AND session_date=?')
      .run('f'.repeat(64), head.pair_id, head.last_session_date))
    await assert.rejects(f.commit(), /malformed JSON/)
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.n, 0)
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM model_champion_history WHERE model_name='opb_arm_prior'").get()?.n, 0)
    assert.equal(f.sql.prepare("SELECT state FROM model_artifact_registry WHERE model_name='opb_arm_prior'").get()?.state, 'offline_failed')
  })
  test('actual authenticated OPB route publishes original evidence and recovers lost projection ACK', async t => {
    const { adminConfigCoreRoutes } = await import('../routes/adminConfigCoreRoutes')
    const f = publication(t)
    const values = new Map([['trading:config', JSON.stringify(f.current.tradingConfig)],
      ['trading:risk_config', JSON.stringify(f.current.riskConfig)]])
    let mode = 'throw', puts = 0
    const kv = {
      async get(key: string, type: string) { const raw = values.get(key); return raw ? type === 'json' ? JSON.parse(raw) : raw : null },
      async put(key: string, value: string) {
        puts++
        if (key === 'trading:config' && mode === 'throw') throw new Error('fixture_kv_unavailable')
        if (key === 'trading:config' && mode === 'drop') return
        values.set(key, value)
        if (key === 'trading:config' && mode === 'lost_ack') throw new Error('fixture_lost_ack')
      },
    }
    const env = { DB: { prepare() { throw new Error('wrong D1 owner') } }, LEARNING_DB: f.db,
      MULTI_D1_ACTIVE_DOMAINS: 'learning', MULTI_D1_STRICT: 'true', KV: kv,
      STOCKVISION_AUTH_TOKEN: 'fixture-local-token' } as any
    let gate = input().gate
    const request = (token = 'fixture-local-token') => adminConfigCoreRoutes.request('/api/admin/config/opb/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ artifact_id: input().artifactId, artifact_checksum: input().artifactChecksum,
        prospective_validation: gate }),
    }, env)
    const OriginalDate = globalThis.Date
    globalThis.Date = class extends OriginalDate {
      constructor(value?: any) { super(value === undefined ? original.now : value) }
      static now() { return new OriginalDate(original.now).getTime() }
    } as DateConstructor
    try {
      assert.equal((await request('wrong')).status, 401)
      assert.equal(puts, 0)
      const failed = await (await request()).json() as any
      assert.equal(failed.pointer_committed, true, JSON.stringify(failed))
      assert.equal(failed.config_projection_verified, false)
      assert.equal(failed.success, false)
      assert.match(failed.reason, /fixture_kv_unavailable/)
      const committed = await readOpbNavCommitReceipt(f.db, input())
      assert(committed)
      const reviews = f.sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all()
      gate = { decision: 'HOLD' }
      f.sql.prepare("UPDATE model_artifact_registry SET live_evidence_json='{}' WHERE model_name='opb_arm_prior'").run()
      mode = 'drop'
      const dropped = await (await request()).json() as any
      assert.equal(dropped.success, false)
      assert.match(dropped.reason, /readback_mismatch/)
      mode = 'lost_ack'
      const lost = await (await request()).json() as any
      assert.equal(lost.success, false)
      mode = 'normal'
      const recovered = await (await request()).json() as any
      assert.equal(recovered.pointer_committed, true, JSON.stringify(recovered))
      assert.equal(recovered.config_projection_verified, true, JSON.stringify(recovered))
      assert.equal(recovered.already_committed, true)
      // Publication may close before the next allocation, but does not claim execution.
      assert.equal(recovered.control_activation_verified, false)
      assert.equal(recovered.success, true, JSON.stringify(recovered))
      assert.equal(recovered.completion_scope, 'publication')
      assert.equal(recovered.control.status, 'awaiting_next_allocation')
      const stored = JSON.parse(values.get('trading:config')!)
      assert.deepEqual(stored.alphaFramework.allocation.opbArmPrior,
        JSON.parse(committed.evidence.gate.candidate_payload_json))
      assert.equal(stored.alphaFramework.allocation.opbArmPrior.validation.decision, 'FAIL')
      assert.equal(stored.alphaFramework.allocation.controller, 'OnlinePortfolioBandit')
      assert.deepEqual(stored.position, f.current.tradingConfig.position)
      assert.deepEqual(await readOpbNavCommitReceipt(f.db, input()), committed)
      assert.equal(f.count(), 1)
      assert.deepEqual(f.sql.prepare('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id').all(), reviews)
      fs.writeFileSync(source + '.responses.json', JSON.stringify([failed, dropped, lost, recovered]))
      const tables = ['model_artifact_registry', 'model_champion_pointers', 'model_champion_history',
        'expected_return_artifact_payloads', 'expected_return_owner_state_v2', 'expected_return_forward_guard_state',
        'active8_ensemble_pointer_v1', 'active8_ensemble_artifacts_v1']
      fs.writeFileSync(source + '.control.json', JSON.stringify({ now: original.now,
        trading_config: stored, risk_config: f.current.riskConfig,
        tables: Object.fromEntries(tables.map(name => [name, {
          schema: f.sql.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql,
          rows: f.sql.prepare(`SELECT * FROM ${name}`).all(),
        }])) }))
    } finally { globalThis.Date = OriginalDate }
  })
  for (const [name, mutation] of [
    ['EV payload', "UPDATE expected_return_artifact_payloads SET artifact_json='{}'"],
    ['ML pointer', "UPDATE active8_ensemble_pointer_v1 SET payload_checksum='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'"],
    ['candidate archive', "UPDATE model_artifact_registry SET state='archived' WHERE model_name='opb_arm_prior'"],
  ] as const) {
    test(`transaction rejects concurrent ${name} change, retaining incumbent`, async t => {
      const f = publication(t)
      f.before(() => { f.sql.exec(mutation) })
      await assert.rejects(f.commit(), /malformed JSON|changed/)
      assert.equal(f.sql.prepare("SELECT count(*) AS n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.n, 0)
      assert.equal(f.sql.prepare("SELECT count(*) AS n FROM model_champion_history WHERE model_name='opb_arm_prior'").get()?.n, 0)
    })
  }
  test('actual HTTP projection rejects context races without overwriting unrelated settings', async t => {
    const { adminConfigCoreRoutes } = await import('../routes/adminConfigCoreRoutes')
    const OriginalDate = globalThis.Date
    globalThis.Date = class extends OriginalDate {
      constructor(value?: any) { super(value === undefined ? original.now : value) }
      static now() { return new OriginalDate(original.now).getTime() }
    } as DateConstructor
    try {
      for (const fault of ['missing_review', 'forged_gate', 'risk_before', 'risk_snapshot',
        'config_snapshot', 'other_prior_snapshot', 'ev_snapshot', 'ml_after', 'pointer_after']) {
        await t.test(fault, async sub => {
          const f = publication(sub)
          const values = new Map([['trading:config', JSON.stringify(f.current.tradingConfig)],
            ['trading:risk_config', JSON.stringify(f.current.riskConfig)]])
          const gate = input().gate
          let mainWrites = 0, once = false
          const change = () => {
            if (fault.startsWith('risk_')) {
              const risk = JSON.parse(values.get('trading:risk_config')!)
              risk.system.killSwitch = !risk.system.killSwitch
              values.set('trading:risk_config', JSON.stringify(risk))
            } else if (fault === 'config_snapshot' || fault === 'other_prior_snapshot') {
              const config = JSON.parse(values.get('trading:config')!)
              if (fault === 'config_snapshot') config.position.maxPctOfPortfolio = 0.125
              else config.alphaFramework.allocation.opbArmPrior = { artifact_id: 'unrelated-change' }
              values.set('trading:config', JSON.stringify(config))
            } else if (fault === 'ev_snapshot') f.sql.exec("UPDATE expected_return_artifact_payloads SET artifact_json='{}'")
            else if (fault === 'ml_after') f.sql.exec("UPDATE active8_ensemble_pointer_v1 SET payload_checksum='changed'")
            else if (fault === 'pointer_after') f.sql.exec("DELETE FROM model_champion_pointers WHERE model_name='opb_arm_prior'")
          }
          if (fault === 'risk_before') change()
          if (fault === 'missing_review') f.sql.exec('DELETE FROM paired_nav_review_parts_v1')
          if (fault === 'forged_gate') gate.nav_validation.mean_daily_nav_delta = 99
          const kv = {
            async get(key: string, type: string) { const raw = values.get(key); return raw ? type === 'json' ? JSON.parse(raw) : raw : null },
            async put(key: string, value: string) {
              values.set(key, value)
              if (key === 'trading:config') mainWrites++
              if (!once && (fault.endsWith('_snapshot') && key.startsWith('trading:config:snapshot:')
                || fault.endsWith('_after') && key === 'trading:config')) { once = true; change() }
            },
          }
          const env = { DB: { prepare() { throw new Error('wrong D1 owner') } }, LEARNING_DB: f.db,
            MULTI_D1_ACTIVE_DOMAINS: 'learning', MULTI_D1_STRICT: 'true', KV: kv,
            STOCKVISION_AUTH_TOKEN: 'fixture-local-token' } as any
          const request = () => adminConfigCoreRoutes.request('/api/admin/config/opb/promote', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-local-token' },
            body: JSON.stringify({ artifact_id: input().artifactId, artifact_checksum: input().artifactChecksum,
              prospective_validation: gate }),
          }, env)
          const response = await (await request()).json() as any
          assert.equal(response.success, false, JSON.stringify(response))
          assert.equal(response.config_projection_verified, false, JSON.stringify(response))
          assert.equal(mainWrites, fault.endsWith('_after') ? 1 : 0, JSON.stringify(response))
          if (fault.endsWith('_snapshot')) {
            assert(once, 'must reach the real asynchronous snapshot boundary')
            assert.equal(response.pointer_committed, true)
            const unchanged = [...values]
            const retry = await (await request()).json() as any
            // The FIRST racing request still failed above. A later stable,
            // independently verified config change retires the stale control;
            // corrupted sources and another owner's prior remain failures.
            if (['risk_snapshot', 'config_snapshot'].includes(fault)) {
              assert.equal(retry.status, 'retired', JSON.stringify(retry))
              assert.equal(retry.pointer_committed, false)
              assert.equal(retry.control_activation_verified, false)
              assert.equal(f.count(), 2)
            } else {
              assert.equal(retry.success, false)
              assert.equal(f.count(), 1)
            }
            assert.deepEqual([...values], unchanged)
          } else if (!fault.endsWith('_after')) assert.equal(f.count(), 0)
        })
      }
    } finally { globalThis.Date = OriginalDate }
  })
  test('interruption after pointer write rolls back registry, pointer and history together', async t => {
    const f = publication(t)
    f.interrupt(8)
    await assert.rejects(f.commit(), /fixture_transaction_interrupted/)
    assert.equal(f.sql.prepare("SELECT state FROM model_artifact_registry WHERE model_name='opb_arm_prior'").get()?.state, 'offline_failed')
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").get()?.n, 0)
    f.interrupt(-1)
    assert.equal((await f.commit()).artifact_id, original.payload.artifact_id)
  })
  test('forged gate or changed original prior cannot reach a write batch', async t => {
    const f = publication(t)
    f.request.gate.nav_validation.mean_daily_nav_delta = 99
    await assert.rejects(f.commit(), /decision_checksum_mismatch/)
    assert.equal(f.count(), 0)
    f.request.gate = input().gate
    f.request.gate.candidate_payload_json += ' '
    await assert.rejects(f.commit(), /source_identity_invalid/)
    assert.equal(f.count(), 0)
  })
  test('current configuration change cannot reuse a candidate comparison', async t => {
    const f = publication(t)
    f.current.riskConfig.maxSingleNamePct = .99
    await assert.rejects(f.commit(), /current_configuration_changed/)
    assert.equal(f.count(), 0)
  })
  test('damaged committed history is not accepted as successful recovery', async t => {
    const f = publication(t)
    await f.commit()
    f.sql.prepare("UPDATE model_champion_history SET evidence_json='{}' WHERE model_name='opb_arm_prior'").run()
    await assert.rejects(readOpbNavCommitReceipt(f.db, input()), /commit_readback_mismatch/)
  })
  test('original family-adjusted NAV support verifies despite offline FAIL', async t => {
    const { db, sql } = database(t)
    const changes = sql.prepare('SELECT total_changes() AS n').get()?.n
    const i = input()
    assert.equal(i.gate.offline_diagnostic.decision, 'FAIL')
    const proof = await verifyNavPromotionEvidence(db, i, new Date(original.now))
    assert(hasVerifiedNavPromotion(proof, i.owner, i.artifactId, i.artifactChecksum, i.gate))
    assert(!hasVerifiedNavPromotion({ ...proof }, i.owner, i.artifactId, i.artifactChecksum, i.gate))
    assert.equal(originalNavComparisonContext(proof).original_comparison.kind, 'allocator_policy_contrast')
    assert.equal(sql.prepare('SELECT total_changes() AS n').get()?.n, changes)
  })
  test('changed caller PASS cannot replace the sealed decision', async t => {
    const { db } = database(t)
    const i = input()
    i.gate.nav_validation.mean_daily_nav_delta = 99
    await assert.rejects(verifyNavPromotionEvidence(db, i, new Date(original.now)), /decision_checksum_mismatch/)
  })
  test('missing review bytes cannot authorize OPB', async t => {
    const { db, sql } = database(t)
    sql.exec('DELETE FROM paired_nav_review_parts_v1')
    await assert.rejects(verifyNavPromotionEvidence(db, input(), new Date(original.now)), /record_parts_incomplete/)
  })
  test('another candidate cannot reuse the same numerical result', async t => {
    const { db } = database(t)
    await assert.rejects(verifyNavPromotionEvidence(db, { ...input(), artifactChecksum: 'f'.repeat(64) },
      new Date(original.now)), /gate_identity_invalid/)
  })
}
