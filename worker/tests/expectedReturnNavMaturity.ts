import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildPipelineDecisionMaturityPacket } from '../src/lib/pipelineDecisionMaturity'
import { projectExpectedReturnNavMaturity } from '../src/lib/expectedReturnNavMaturity'

// Called by the original Python evaluator test; no handcrafted PASS receipt.
async function main() {
const input = process.env.NAV_ORIGINAL_FIXTURE
assert.ok(input, 'original evaluator fixture required')
const data = JSON.parse(fs.readFileSync(input, 'utf8'))
const db = new DatabaseSync(':memory:')
db.exec(data.registry_schema)
const rows = data.tables.model_artifact_registry
for (const row of rows) {
  const keys = Object.keys(row)
  db.prepare(`INSERT INTO model_artifact_registry (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => row[k]))
}
const before = db.prepare('SELECT * FROM model_artifact_registry ORDER BY artifact_id').all()
// A newly generated, unevaluated registry row must not inherit older NAV dates.
// Deliberately incomplete identity: the UI must expose that, not silently hide it.
for (const row of rows) {
  const noise = { ...row, artifact_id: `${row.artifact_id}:new-unverified`,
    source_run_date: data.now.slice(0, 10), updated_at: data.now,
    live_evidence_json: null, live_gate_status: 'not_started', state: 'shadowing' }
  const keys = Object.keys(noise)
  db.prepare(`INSERT INTO model_artifact_registry (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => noise[k]))
}
const expectedReadOnly = db.prepare('SELECT * FROM model_artifact_registry ORDER BY artifact_id').all()
const binding = {
  prepare(sql: string) {
    let args: any[] = []
    return {
      bind(...params: any[]) { args = params; return this },
      async all() { return { results: db.prepare(sql).all(...args), success: true } },
      async first() { return db.prepare(sql).get(...args) ?? null },
      async run() { throw Error('read model attempted mutation') },
    }
  },
}
const packet = await buildPipelineDecisionMaturityPacket({ DB: binding,
  KV: { get: async () => null } } as any, data.now.slice(0, 10))
for (const [owner, id] of [['l4_alpha_ev', 'l4'], ['allocator_ev_fusion', 'fusion']]) {
  const row = rows.find((r: any) => r.model_name === owner)
  const original = JSON.parse(row.live_evidence_json).nav_validation
  const stage = packet.stages.find(s => s.id === id)!
  assert.ok(stage)
  assert.equal(stage.nav_gate?.availability, 'available', JSON.stringify(stage.nav_gate))
  assert.equal(stage.nav_gate?.decision, original.decision)
  assert.equal(stage.nav_gate?.evaluable_dates, original.evaluable_date_count)
  assert.equal(stage.nav_gate?.evaluable_dates, 10)
  assert.equal(stage.nav_gate?.promotion_allowed, false)
  assert.equal(stage.nav_gate?.artifact_id, row.artifact_id)
  assert.equal(stage.candidate_versions?.latest_candidate?.artifact_id, `${row.artifact_id}:new-unverified`)
  assert.equal(stage.candidate_versions?.latest_candidate?.identity_valid, false)
  assert.equal(stage.candidate_versions?.evaluated_candidate?.artifact_id, row.artifact_id)
  assert.equal(stage.candidate_versions?.evaluated_candidate?.checksum, row.checksum)
  assert.equal(stage.candidate_versions?.evaluation_query_status, 'available')
  assert.equal(stage.candidate_versions?.different_artifacts, null, 'unverified metadata cannot prove comparable identity')
  assert.equal(stage.nav_gate?.as_of_date, original.as_of_date)
  assert.equal(stage.lineage.evidence_date, original.as_of_date)
  assert.equal(stage.lineage.artifact_id, row.artifact_id)
  assert.equal(stage.lineage.oof_applicable, false)
  assert.equal(stage.metrics.find(m => m.key === 'nav_mean_delta')?.value, original.mean_daily_nav_delta)
  assert.equal(stage.metrics.find(m => m.key === 'nav_holm_p')?.value, original.holm_adjusted_p)
  assert.ok(stage.metrics.filter(m => m.scope === 'promotion_gate').every(m => m.key.startsWith('nav_')))
  assert.notEqual(stage.status, 'serving')

  for (const fault of ['checksum', 'candidate', 'future', 'count', 'raw', 'wrapper']) {
    const bad = structuredClone(row)
    const gate = JSON.parse(bad.live_evidence_json)
    if (fault === 'checksum') bad.checksum = 'wrong'
    if (fault === 'candidate') bad.artifact_id = 'wrong'
    if (fault === 'count') gate.evaluable_date_count = 99
    if (fault === 'raw') gate.nav_validation.decision_payload_json += ' '
    if (fault === 'wrapper') gate.decision = 'HOLD'
    bad.live_evidence_json = JSON.stringify(gate)
    const target = structuredClone(stage)
    await projectExpectedReturnNavMaturity(target, bad,
      fault === 'future' ? '2026-01-01' : data.now.slice(0, 10))
    assert.equal(target.nav_gate?.availability, 'blocked', fault)
    assert.equal(target.nav_gate?.evaluable_dates, null, fault)
    assert.equal(target.status, 'blocked', fault)
    assert.equal(target.candidate_versions, undefined, 'refresh cannot keep stale identity comparison')
  }
  const absent = structuredClone(stage)
  await projectExpectedReturnNavMaturity(absent, undefined, data.now.slice(0, 10))
  assert.equal(absent.nav_gate?.availability, 'missing')
  assert.equal(absent.nav_gate?.evaluable_dates, null)
  assert.equal(absent.progress, null)
  const serving = structuredClone(stage)
  serving.status = 'serving'
  await projectExpectedReturnNavMaturity(serving, undefined, data.now.slice(0, 10))
  assert.equal(serving.status, 'serving', 'candidate missing must not invent serving retirement')
}
assert.deepEqual(db.prepare('SELECT * FROM model_artifact_registry ORDER BY artifact_id').all(), expectedReadOnly)
assert.deepEqual(rows.map((row: any) => db.prepare('SELECT * FROM model_artifact_registry WHERE artifact_id=?').get(row.artifact_id)),
  before.sort((a: any, b: any) => rows.findIndex((r: any) => r.artifact_id === a.artifact_id) - rows.findIndex((r: any) => r.artifact_id === b.artifact_id)))
fs.writeFileSync(`${input}.maturity.json`, JSON.stringify(packet))
db.close()
console.log('Original evaluator -> actual SQLite read-model: both NAV decisions, integrity, dates, missing and read-only checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
