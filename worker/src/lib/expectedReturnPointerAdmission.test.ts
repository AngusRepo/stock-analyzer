import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { commitExpectedReturnChampion } from './expectedReturnServingRegistry'

class Statement {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: any[] = []) {}
  bind(...values: any[]) { return new Statement(this.db, this.sql, values) }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null }
  async all() { return { results: this.db.prepare(this.sql).all(...this.values) } }
}

function setup(finding: string | null = 'walk_forward_not_stable') {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync('domain-migrations/learning/0038_expected_return_candidate_preoutcome_evaluations.sql', 'utf8'))
  db.exec(`
    CREATE TABLE model_artifact_registry(artifact_id TEXT PRIMARY KEY, model_name TEXT, version TEXT,
      state TEXT, artifact_path TEXT, checksum TEXT, offline_gate_decision TEXT,
      offline_gate_failed_gates TEXT, promotion_decision TEXT, approval_state TEXT,
      live_gate_status TEXT, live_evidence_json TEXT, updated_at TEXT);
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
    CREATE TABLE strategy_route_backfill_eligibility_v1(signal_date TEXT, route_version TEXT,
      affinity_version TEXT, status TEXT, reference_rows INTEGER);
    INSERT INTO strategy_route_backfill_eligibility_v1 VALUES('2026-08-25',
      'strategy-semantic-continuous-affinity-v5','strategy-threshold-margin-affinity-v2','eligible',30);
  `)
  const checksum = 'a'.repeat(64), fingerprint = 'b'.repeat(64)
  const id = `l4_alpha_ev:v1:${checksum}`, path = `candidate/${checksum}.json`
  const failed = finding ? [finding] : []
  db.prepare('INSERT INTO model_artifact_registry(artifact_id,model_name,version,state,artifact_path,checksum,offline_gate_decision,offline_gate_failed_gates) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, 'l4_alpha_ev', 'v1', 'shadowing', path, checksum, finding ? 'FAIL' : 'PASS', JSON.stringify(failed))
  const dates = ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31',
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07']
  dates.forEach((day, i) => db.prepare(`INSERT INTO expected_return_candidate_preoutcome_evaluations(
    evaluation_id,candidate_artifact_id,candidate_artifact_checksum,model_name,model_version,
    model_fingerprint,cohort_id,source_run_date,artifact_trained_until,selection_semantic_floor_date,
    extension_manifest_checksum,prediction_date,label_known_date,sample_count,quality_decision,evidence_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`eval-${i}`, id, checksum, 'l4_alpha_ev', 'v1', fingerprint,
    'cohort', '2026-08-30', '2026-08-18', '2026-08-25', 'e'.repeat(64), day, '2026-09-15', 30, 'PASS', '{}'))
  const input = {
    owner: 'l4_alpha_ev' as const,
    artifact: { expected_return_owner: 'l4_alpha_ev', model_version: 'v1', model_fingerprint: fingerprint,
      trained_until: '2026-08-18', training_data: { cohort_id: 'cohort' } },
    artifactId: id, artifactPath: path, artifactChecksum: checksum,
    candidateId: 'candidate', promotionPacketId: 'packet', sourceRunDate: '2026-08-30',
    offlineAdmission: { schema_version: 'expected-return-offline-admission-v1', decision: 'PASS',
      hard_blockers: [], source_validation_decision: finding ? 'FAIL' : 'PASS', source_failed_gates: failed },
    prospectiveValidation: { schema_version: 'expected-return-candidate-forward-gate-v2', decision: 'PASS', failed_gates: [],
      candidate_artifact_id: id, candidate_artifact_checksum: checksum, model_fingerprint: fingerprint,
      source_run_date: '2026-08-30', artifact_trained_until: '2026-08-18', selection_semantic_floor_date: '2026-08-25',
      prediction_date_min: dates[0], prediction_date_max: dates.at(-1), label_known_date_min: '2026-09-15',
      label_known_date_max: '2026-09-15', training_dispatched: false, minimum_evaluable_dates: 10,
      evaluable_date_count: 10, corr_or_delta_lcb90: 0, spread_or_delta_lcb90: 0, top_return_lcb90: .01,
      evaluation_evidence_checksum: '' },
  }
  db.exec(`UPDATE expected_return_candidate_preoutcome_evaluations SET prediction_corr=.2,baseline_corr=.2,
    corr_delta=0,spread=.01,baseline_spread=.01,spread_delta=0,top_return=.01`)
  const source = db.prepare(`SELECT prediction_date,label_known_date,sample_count,prediction_corr,baseline_corr,
    corr_delta,spread,baseline_spread,spread_delta,top_return,quality_decision
    FROM expected_return_candidate_preoutcome_evaluations ORDER BY prediction_date`).all()
  const encoded = source.map(row => JSON.stringify(row))
  source.forEach((row, i) => db.prepare('UPDATE expected_return_candidate_preoutcome_evaluations SET evidence_json=? WHERE prediction_date=?')
    .run(encoded[i], row.prediction_date))
  input.prospectiveValidation.evaluation_evidence_checksum = createHash('sha256').update(encoded.join('\n')).digest('hex')
  db.prepare('UPDATE model_artifact_registry SET live_evidence_json=?').run(JSON.stringify(input.prospectiveValidation))
  const adapter = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (statements: Statement[]) => {
      db.exec('BEGIN')
      try {
        const results = statements.map(s => ({ success: true, meta: s.db.prepare(s.sql).run(...s.values) }))
        db.exec('COMMIT')
        return results
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
  return { db, adapter, input }
}

// Positive transaction/rollback/retry coverage now uses ORIGINAL Python NAV
// evidence in pairedNavPromotionEvidence.test.ts, not a fabricated OOF PASS.
// The legacy fixture remains to prove it cannot become an alternate authority.
 test('legacy cross-section PASS cannot commit without original NAV review', async () => {
  const { db, adapter, input } = setup()
  try {
    await assert.rejects(commitExpectedReturnChampion(adapter, input), /nav_promotion_gate_identity_invalid/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers').get()?.n, 0)
    assert.equal(db.prepare('SELECT offline_gate_decision AS decision FROM model_artifact_registry').get()?.decision, 'FAIL')
  } finally { db.close() }
})

for (const finding of ['feature_contract_invalid', 'unknown_failure']) {
  test(`${finding} cannot be bypassed with claimed admission PASS`, async () => {
    const { db, adapter, input } = setup(finding)
    try {
      await assert.rejects(commitExpectedReturnChampion(adapter, input), /offline_admission_invalid/)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers').get()?.n, 0)
    } finally { db.close() }
  })
}

for (const value of [-.01, null, true, '', ' ', NaN, Infinity]) {
  test(`invalid/negative lower bound ${String(value)} cannot move pointer`, async () => {
    const { db, adapter, input } = setup(null)
    try {
      (input.prospectiveValidation as any).corr_or_delta_lcb90 = value
      db.prepare('UPDATE model_artifact_registry SET live_evidence_json=?').run(JSON.stringify(input.prospectiveValidation))
      await assert.rejects(commitExpectedReturnChampion(adapter, input), /nav_promotion_gate_identity_invalid/)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers').get()?.n, 0)
    } finally { db.close() }
  })
}

test('ten claimed dates with only four materialized dates cannot move pointer', async () => {
  const { db, adapter, input } = setup()
  try {
    db.prepare("DELETE FROM expected_return_candidate_preoutcome_evaluations WHERE prediction_date>'2026-08-28'").run()
    await assert.rejects(commitExpectedReturnChampion(adapter, input), /nav_promotion_gate_identity_invalid/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers').get()?.n, 0)
  } finally { db.close() }
})

test('forged positive gate cannot replace the materialized owner verdict', async () => {
  const { db, adapter, input } = setup()
  try {
    input.prospectiveValidation.top_return_lcb90 = .99
    await assert.rejects(commitExpectedReturnChampion(adapter, input), /live_gate_mismatch/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers').get()?.n, 0)
  } finally { db.close() }
})

test('same date counts with changed evidence cannot reuse an old PASS', async () => {
  const { db, adapter, input } = setup()
  try {
    db.exec("UPDATE expected_return_candidate_preoutcome_evaluations SET top_return=-.2 WHERE evaluation_id='eval-0'")
    await assert.rejects(commitExpectedReturnChampion(adapter, input), /nav_promotion_gate_identity_invalid/)
    db.exec("UPDATE expected_return_candidate_preoutcome_evaluations SET evidence_json=json_set(evidence_json,'$.top_return',top_return)")
    await assert.rejects(commitExpectedReturnChampion(adapter, input), /nav_promotion_gate_identity_invalid/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_champion_pointers').get()?.n, 0)
  } finally { db.close() }
})
