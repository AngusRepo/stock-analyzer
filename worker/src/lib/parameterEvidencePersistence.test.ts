import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ensureParameterCandidateTables, recordParameterCandidateEvidence,
  validateParameterCandidateEvidencePacket } from './parameterCandidateRegistry'

class Statement {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly params: any[] = []) {}
  bind(...params: any[]) { return new Statement(this.db, this.sql, params) }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null }
  async run() { return { success: true, meta: this.db.prepare(this.sql).run(...this.params) } }
}

async function setup() {
  const sqlite = new DatabaseSync(':memory:')
  const client = {
    prepare(sql: string) { return new Statement(sqlite, sql) },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN')
      try {
        const result = []
        for (const statement of statements) result.push(await statement.run())
        sqlite.exec('COMMIT')
        return result
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
  await ensureParameterCandidateTables(client)
  sqlite.exec("INSERT INTO parameter_candidate_registry(candidate_id,source,status) VALUES('candidate-A','test','SHADOW_COLLECTING')")
  const evidence = { candidate_id: 'candidate-A', decision: 'PASS',
    gate: { decision: 'PASS', validation_packet: { decision: 'PASS' }, inputs: { research_search_validation: {
      status: 'PASS', run_key: 'fixture-search', selected_trial_id: 'trial-1',
      validation_receipt_id: 'a'.repeat(64), panel_checksum: 'b'.repeat(64), trial_receipt_ids: ['c'.repeat(64)],
    } } } }
  return { sqlite, client, evidence }
}

test('recorded evidence, registry and event agree; inline PASS cannot override raw FAIL', async () => {
  const { sqlite, client, evidence } = await setup()
  try {
    const passed = await recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', evidence })
    assert.equal(passed.status, 'PROMOTION_READY')
    assert.deepEqual(await recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', evidence }), passed)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_evidence').get()?.n, 1)
    assert.equal((await validateParameterCandidateEvidencePacket(client, { candidateId: 'candidate-A' })).ok, true)
    const canonical = JSON.parse(String(sqlite.prepare('SELECT latest_evidence_json FROM parameter_candidate_registry').get()?.latest_evidence_json))
    assert.equal((await validateParameterCandidateEvidencePacket(client, { candidateId: 'candidate-A', evidencePacket: canonical })).ok, true)
    assert.equal((await validateParameterCandidateEvidencePacket(client, { candidateId: 'candidate-A', evidencePacket: { ...canonical, forged: true } })).error, 'submitted_evidence_not_canonical')
    const legacy = { ...canonical, gate: { ...canonical.gate, inputs: {} } }
    sqlite.prepare('UPDATE parameter_candidate_registry SET latest_evidence_json=?').run(JSON.stringify(legacy))
    assert.equal((await validateParameterCandidateEvidencePacket(client, { candidateId: 'candidate-A' })).error, 'verified_search_binding_required')
    sqlite.prepare('UPDATE parameter_candidate_registry SET latest_evidence_json=?').run(JSON.stringify(canonical))

    const failed = await recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', decision: 'PASS',
      evidence: { ...evidence, gate: { ...evidence.gate, decision: 'FAIL' } } })
    assert.equal(failed.status, 'NOT_PROMOTION_READY')
    assert.equal(failed.promotion_packet_id, null)
    assert.equal((await validateParameterCandidateEvidencePacket(client, { candidateId: 'candidate-A' })).ok, false)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_evidence').get()?.n, 2)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_events').get()?.n, 2)
  } finally { sqlite.close() }
})

test('new evidence changes packet, identical retry preserves it, concurrent revision cannot be overwritten', async () => {
  const { sqlite, client, evidence } = await setup()
  try {
    const first = await recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', evidence })
    const nextEvidence = { ...evidence, source_run_date: '2026-09-08' }
    const second = await recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', evidence: nextEvidence })
    assert.notEqual(second.promotion_packet_id, first.promotion_packet_id)
    assert.deepEqual(await recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', evidence: nextEvidence }), second)
    const originalBatch = client.batch.bind(client)
    const racingClient = {
      prepare: client.prepare.bind(client),
      async batch(statements: Statement[]) {
        if (statements.some(s => s.sql.includes('INSERT INTO parameter_candidate_evidence'))) {
          sqlite.exec("UPDATE parameter_candidate_registry SET status='INFRA_BLOCKED'")
        }
        return originalBatch(statements as unknown as D1PreparedStatement[])
      },
    } as unknown as D1Database
    await assert.rejects(recordParameterCandidateEvidence(racingClient, { candidateId: 'candidate-A',
      evidence: { ...nextEvidence, source_run_date: '2026-09-09' } }), /NOT NULL/)
    assert.equal(sqlite.prepare('SELECT status FROM parameter_candidate_registry').get()?.status, 'INFRA_BLOCKED')
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_evidence').get()?.n, 2)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_events').get()?.n, 2)
  } finally { sqlite.close() }
})

test('unregistered/mismatched evidence cannot manufacture a candidate identity', async () => {
  const { sqlite, client, evidence } = await setup()
  try {
    await assert.rejects(recordParameterCandidateEvidence(client, { candidateId: 'candidate-A',
      evidence: { ...evidence, candidate_id: 'candidate-B' } }), /identity_mismatch/)
    await assert.rejects(recordParameterCandidateEvidence(client, { candidateId: 'candidate-B',
      evidence: { ...evidence, candidate_id: 'candidate-B' } }), /not_registered/)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_evidence').get()?.n, 0)
  } finally { sqlite.close() }
})

test('failure of event write rolls back evidence and ready state together', async () => {
  const { sqlite, client, evidence } = await setup()
  try {
    sqlite.exec("CREATE TRIGGER simulate_failure BEFORE INSERT ON parameter_candidate_events BEGIN SELECT RAISE(ABORT,'event_write_failed'); END")
    await assert.rejects(recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', evidence }), /event_write_failed/)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_evidence').get()?.n, 0)
    assert.equal(sqlite.prepare('SELECT status FROM parameter_candidate_registry').get()?.status, 'SHADOW_COLLECTING')
    sqlite.exec('DROP TRIGGER simulate_failure')
    assert.equal((await recordParameterCandidateEvidence(client, { candidateId: 'candidate-A', evidence })).status, 'PROMOTION_READY')
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM parameter_candidate_evidence').get()?.n, 1)
  } finally { sqlite.close() }
})
