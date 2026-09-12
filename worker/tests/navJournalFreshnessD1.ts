// Original Python PASS/ledger/correction. No cloud connection or synthetic PASS.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { verifyNavPromotionEvidence } from '../src/lib/pairedNavPromotionEvidence'
import { buildExpectedReturnOwnerPromotionPlan } from '../src/lib/expectedReturnArtifactPromotion'
import { commitExpectedReturnChampion } from '../src/lib/expectedReturnServingRegistry'

const original = JSON.parse(fs.readFileSync(process.env.NAV_JOURNAL_FRESHNESS_FIXTURE!, 'utf8'))
async function fixture(run: (v: any) => Promise<void>) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("isolated") } }',
    d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING')
    for (const sql of original.schema) await db.prepare(sql).run()
    const insert = async (tables: any) => {
      for (const [table, rows] of Object.entries(tables)) for (const row of rows as any[]) {
        const keys = Object.keys(row)
        await db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
          .bind(...Object.values(row)).run()
      }
    }
    await insert(original.tables)
    const p = original.payload
    const id = p.prospective_validation.nav_validation.allocation_snapshot_id
    const config = JSON.parse(original.tables.paired_nav_frozen_parts_v1.filter((row: any) => row.snapshot_id === id)
      .sort((a: any, b: any) => a.part_no - b.part_no).map((row: any) => row.payload_text).join('')).content.configuration
    const formal = config.formal_baseline_identity
    for (const ddl of [
      'ALTER TABLE model_artifact_registry ADD COLUMN approval_state TEXT',
      `CREATE TABLE expected_return_artifact_payloads(artifact_id TEXT PRIMARY KEY,model_name TEXT,model_version TEXT,
        serving_mode TEXT,artifact_json TEXT,payload_checksum TEXT,source_artifact_path TEXT,
        source_artifact_checksum TEXT,source_cohort_id TEXT,updated_at TEXT)`,
      `CREATE TABLE model_champion_pointers(model_name TEXT PRIMARY KEY,champion_version TEXT,champion_artifact_id TEXT,
        rollback_version TEXT,rollback_artifact_id TEXT,promoted_at TEXT,promotion_reason TEXT,promotion_evidence_json TEXT,updated_at TEXT)`,
      `CREATE TABLE expected_return_owner_state_v2(owner TEXT PRIMARY KEY,owner_state TEXT,champion_artifact_id TEXT,
        reason_code TEXT,contract_manifest_version TEXT,updated_at TEXT)`,
      `CREATE TABLE model_champion_history(event_id TEXT PRIMARY KEY,model_name TEXT,version TEXT,artifact_id TEXT,
        effective_at TEXT,retired_at TEXT,source TEXT,evidence_grade TEXT,evidence_json TEXT)`,
      `CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,
        payload_checksum TEXT,base_artifact_set_checksum TEXT)`,
      `CREATE TABLE active8_ensemble_artifacts_v1(artifact_id TEXT PRIMARY KEY,cohort_id TEXT,payload_checksum TEXT,
        base_artifact_set_checksum TEXT,validation_decision TEXT,state TEXT,production_effect INTEGER)`,
    ]) await db.prepare(ddl).run()
    await db.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)')
      .bind(formal.artifact_id, formal.cohort_id, formal.payload_checksum, formal.base_artifact_set_checksum).run()
    await db.prepare("INSERT INTO active8_ensemble_artifacts_v1 VALUES(?,?,?,?,'PASS','production',1)")
      .bind(formal.artifact_id, formal.cohort_id, formal.payload_checksum, formal.base_artifact_set_checksum).run()
    const check = { owner: 'l4_alpha_ev', artifactId: p.artifact_id, artifactChecksum: p.artifact_checksum,
      gate: p.prospective_validation }
    const proof = await verifyNavPromotionEvidence(db as any, check, new Date(original.now))
    const plan = buildExpectedReturnOwnerPromotionPlan({}, 'l4_alpha_ev', p, proof)
    assert.equal(plan.eligible, true)
    const input = { owner: 'l4_alpha_ev' as const, artifact: plan.serving_artifact!, artifactId: p.artifact_id,
      artifactPath: p.artifact_path, artifactChecksum: p.artifact_checksum, candidateId: 'fixture', promotionPacketId: 'fixture',
      sourceRunDate: p.source_run_date, prospectiveValidation: p.prospective_validation, offlineAdmission: p.offline_admission,
      currentConfigReader: async () => ({ tradingConfig: config.trading_config, riskConfig: config.risk_config }) }
    await run({ db, check, input, add: () => insert(original.added),
      addOtherFamily: () => insert({ paired_nav_daily_journal_v1: original.added.paired_nav_daily_journal_v1
        .filter((row: any) => !p.prospective_validation.nav_validation.review_family_journal_frontier
          .some((head: any) => head.pair_id === row.pair_id)) }) })
  } finally { await mf.dispose() }
}

test('current original proof can commit through the actual owner', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(original.now) })
  await fixture(async ({ db, input }) => {
    await commitExpectedReturnChampion(db as any, input)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM model_champion_pointers').first())!.n, 1)
  })
})

test('an exported PASS cannot ignore a subsequently committed original correction', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(original.now) })
  await fixture(async ({ db, check, add }) => {
    await add()
    await assert.rejects(verifyNavPromotionEvidence(db as any, check, new Date(original.now)), /journal_frontier_changed/)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM model_champion_pointers').first())!.n, 0)
  })
})

test('another family advancing does not create a global adoption veto', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(original.now) })
  await fixture(async ({ db, input, addOtherFamily }) => {
    await addOtherFamily()
    await commitExpectedReturnChampion(db as any, input)
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM model_champion_pointers').first())!.n, 1)
  })
})

test('a correction between proof verification and pointer transaction aborts the actual batch', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(original.now) })
  await fixture(async ({ db, input, add }) => {
    const raced = { prepare: (sql: string) => db.prepare(sql), batch: async (statements: any[]) => {
      await add()
      return db.batch(statements)
    } }
    await assert.rejects(commitExpectedReturnChampion(raced as any, input), /journal_frontier_changed|malformed JSON/)
    for (const table of ['model_champion_pointers', 'model_champion_history', 'expected_return_artifact_payloads'])
      assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first())!.n, 0)
    assert.notEqual((await db.prepare('SELECT state FROM model_artifact_registry WHERE artifact_id=?')
      .bind(input.artifactId).first())!.state, 'production')
  })
})
