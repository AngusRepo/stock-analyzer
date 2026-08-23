import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import { persistSelectionEvidenceV4 } from './selectionReferenceEvidence'
import { STRATEGY_FORMAL_LABELER_VERSION } from './strategySpec'

const schema = fs.readFileSync('domain-schemas/learning.sql', 'utf8').replace(/\r\n/g, '\n')

function tableSql(table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`
  const start = schema.indexOf(marker)
  const end = schema.indexOf('\n);', start)
  assert(start >= 0 && end > start, `missing schema for ${table}`)
  return schema.slice(start, end + 3)
}

const input: Parameters<typeof persistSelectionEvidenceV4>[1] = {
  signalDate: '2026-08-24',
  producerRunId: 'screener-2026-08-24-cas-test',
  strategyCount: 1,
  strategyRegistryChecksum: 'sha256:registry-cas-test',
  labelerVersion: STRATEGY_FORMAL_LABELER_VERSION,
  evidenceArtifactId: 'artifact:selection-evidence:cas-test',
  references: [{
    signal_date: '2026-08-24',
    symbol: '2330',
    producer_run_id: 'screener-2026-08-24-cas-test',
    name: 'TSMC',
    market_segment: 'listed',
    sector: 'semiconductor',
    strategy_selected: 1,
    selection_stage: 'strategy_selected',
    rejection_reason: null,
    score_v2: 72,
    score_components: '{"version":"score_v2","finalScore":72}',
    feature_available: 1,
    feature_rejection_reason: null,
    strategy_labeler_version: STRATEGY_FORMAL_LABELER_VERSION,
    strategy_affinity_version: 'affinity-v1',
    strategy_router_version: 'router-v1',
    strategy_router_score: 0.6,
    strategy_challenger_affinity_version: null,
    strategy_challenger_route_version: null,
    strategy_challenger_route_score: null,
    strategy_registry_checksum: 'sha256:registry-cas-test',
  }],
  matrix: [{
    signal_date: '2026-08-24',
    symbol: '2330',
    producer_run_id: 'screener-2026-08-24-cas-test',
    strategy_id: 'strategy-cas-test',
    strategy_version: 'v1',
    strategy_status: 'active',
    alpha_bucket: 'trend',
    family_id: 'trend-reclaim',
    production_owner: 1,
    strategy_hit: 1,
    weak_label: 0.6,
    affinity: 0.6,
    affinity_version: 'affinity-v1',
    match_strength: 0.6,
    threshold_margin: 0.1,
    affinity_evidence_count: 5,
    position_weight: 1,
    challenger_affinity: 0,
    challenger_affinity_version: null,
    challenger_position_weight: 0,
    overlap: 0,
    evaluable: 1,
    evaluability_status: 'EVALUABLE',
    unavailable_reason: null,
    labeler_version: STRATEGY_FORMAL_LABELER_VERSION,
    strategy_registry_checksum: 'sha256:registry-cas-test',
  }],
}

async function main(): Promise<void> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['LEARNING', 'IDENTITY'],
  })
  try {
    const learning = await mf.getD1Database('LEARNING')
    const identity = await mf.getD1Database('IDENTITY')
    for (const table of [
      'selection_reference_snapshots_v1',
      'strategy_label_matrix_v4',
      'strategy_label_matrix_runs_v4',
      'selection_evidence_staging_runs_v1',
      'selection_reference_snapshots_staging_v1',
      'strategy_label_matrix_staging_v4',
    ]) await learning.prepare(tableSql(table)).run()
    await identity.exec('CREATE TABLE stocks (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE);')
    await identity.prepare('INSERT INTO stocks (id, symbol) VALUES (?, ?)').bind(1, '2330').run()

    const attempts = await Promise.allSettled(Array.from(
      { length: 8 },
      () => persistSelectionEvidenceV4(learning, input, identity),
    ))
    assert(attempts.some((row) => row.status === 'fulfilled'), 'one writer must promote')
    for (const row of attempts) {
      if (row.status === 'rejected') {
        assert.match(String(row.reason), /selection_evidence_writer_busy/)
      }
    }

    const ready = await learning.prepare(`
      SELECT status, evidence_artifact_id, payload_checksum, promotion_attempt_id,
             reference_candidate_count, persisted_cell_count
        FROM strategy_label_matrix_runs_v4
       WHERE producer_run_id=?
    `).bind(input.producerRunId).first<any>()
    assert.equal(ready?.status, 'ready')
    assert.equal(ready?.evidence_artifact_id, input.evidenceArtifactId)
    assert.match(String(ready?.payload_checksum), /^sha256:[a-f0-9]{64}$/)
    assert.match(String(ready?.promotion_attempt_id), /^[0-9a-f-]{36}$/)
    assert.equal(Number(ready?.reference_candidate_count), 1)
    assert.equal(Number(ready?.persisted_cell_count), 1)
    assert.equal(Number((await learning.prepare(
      'SELECT COUNT(*) count FROM selection_reference_snapshots_v1 WHERE producer_run_id=?',
    ).bind(input.producerRunId).first<any>())?.count), 1)
    assert.equal(Number((await learning.prepare(
      'SELECT COUNT(*) count FROM strategy_label_matrix_v4 WHERE producer_run_id=?',
    ).bind(input.producerRunId).first<any>())?.count), 1)

    const immutableReceipt = JSON.stringify(ready)
    assert.deepEqual(await persistSelectionEvidenceV4(learning, input, identity), {
      referenceRows: 1,
      matrixRows: 1,
    })
    assert.equal(JSON.stringify(await learning.prepare(`
      SELECT status, evidence_artifact_id, payload_checksum, promotion_attempt_id,
             reference_candidate_count, persisted_cell_count
        FROM strategy_label_matrix_runs_v4
       WHERE producer_run_id=?
    `).bind(input.producerRunId).first<any>()), immutableReceipt)

    const changedPayload = {
      ...input,
      matrix: input.matrix.map((row) => ({ ...row, affinity: 0.9 })),
    }
    await assert.rejects(
      persistSelectionEvidenceV4(learning, changedPayload, identity),
      /strategy_label_matrix_immutable_run_conflict/,
    )
    await assert.rejects(
      persistSelectionEvidenceV4(learning, { ...input, evidenceArtifactId: 'artifact:other' }, identity),
      /strategy_label_matrix_immutable_run_conflict/,
    )
    assert.equal(Number((await learning.prepare(
      'SELECT affinity FROM strategy_label_matrix_v4 WHERE producer_run_id=?',
    ).bind(input.producerRunId).first<any>())?.affinity), 0.6)

    await learning.prepare(
      'UPDATE selection_reference_snapshots_v1 SET stock_id=99 WHERE producer_run_id=?',
    ).bind(input.producerRunId).run()
    await assert.rejects(
      persistSelectionEvidenceV4(learning, input, identity),
      /selection_reference_ready_contract_mismatch/
    )

    console.log('selection evidence writer CAS integration passed')
  } finally {
    await mf.dispose()
  }
}

void main().catch((error) => {
  throw error
})