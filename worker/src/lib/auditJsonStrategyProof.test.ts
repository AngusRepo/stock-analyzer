import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE, runAuditJsonArchiveRetention } from './auditJsonArchive'
import { auditHistoricalSelectionEvidenceRecoveryPreflight } from './historicalSelectionEvidenceRecoveryPreflight'
import { sha256Text } from './datasetSnapshots'
import { resolveScreenerEvidence } from './screenerEvidenceResolver'

const learningSchema = readFileSync(new URL('../../domain-schemas/learning.sql', import.meta.url), 'utf8')
const opsSchema = readFileSync(new URL('../../domain-schemas/ops.sql', import.meta.url), 'utf8')

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  for (const name of ['strategy_decision_log', 'strategy_candidate_contexts', 'dataset_snapshots',
    'canonical_selection_labels_v4', 'canonical_selection_label_rejections_v4',
    'selection_reference_snapshots_v1', 'strategy_label_matrix_v4', 'strategy_label_matrix_runs_v4',
    'data_retention_runs', 'data_retention_run_items', 'data_retention_cursors',
    'screener_funnel_items', 'screener_funnel_runs', 'canonical_run_heads']) {
    const ddl = (learningSchema + '\n' + opsSchema).match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))
    assert(ddl, `production domain schema missing: ${name}`)
    db.exec(ddl[0])
  }
  const stats = { puts: 0, manifests: 0, sourceUpdates: 0 }
  const adapter = { prepare(sql: string) {
    let params: any[] = []
    return {
      sql, get params() { return params },
      bind(...values: any[]) { params = values; return this },
      async all() { return { results: db.prepare(sql).all(...params) } },
      async first() { return db.prepare(sql).get(...params) ?? null },
      async run() {
        if (sql.includes('INTO dataset_snapshots')) stats.manifests++
        if (sql.includes('WITH backed_up')) stats.sourceUpdates++
        return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }
      },
    }
  }, async batch(statements: Array<{ run(): Promise<unknown> }>) {
    db.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      db.exec('COMMIT')
      return results
    } catch (error) { db.exec('ROLLBACK'); throw error }
  } }
  const objects = new Map<string, string>()
  const state = { onPut: null as (() => void) | null }
  const env = { DB: adapter, ARTIFACTS: {
    async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body } },
    async put(key: string, body: string, options: any) {
      assert.equal(options.onlyIf.etagDoesNotMatch, '*')
      assert.equal(options.customMetadata.checksum, await sha256Text(body))
      assert.equal(options.customMetadata.minimum_retention_days, '3650')
      objects.set(key, body); stats.puts++; state.onPut?.()
    },
  } } as any
  function insert(id: string, context: string, evidence: string) {
    db.prepare(`INSERT INTO strategy_decision_log(decision_id,date,symbol,strategy_id,strategy_version,
      strategy_status,alpha_bucket,reason_code,context_json,evidence_json,context_id,evidence_artifact_id,
      evaluation_contract_version) VALUES(?,'2026-01-01',?,'S1','v1','challenger','test','ok',?,?,'context','artifact','strategy-evaluation-v2')`)
      .run(id, id, context, evidence)
  }
  let sequence = 0
  const run = (limit = 100) => runAuditJsonArchiveRetention(env, {
    businessDate: '2026-09-30', runId: `fixture-${++sequence}`, targets: ['strategy_decision_log'],
    dryRun: false, confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE, limitPerTable: limit,
  })
  const read = (id: string) => db.prepare('SELECT * FROM strategy_decision_log WHERE decision_id=?').get(id)!
  return { db, env, stats, objects, state, insert, run, read }
}

const hotProof = {
  pit_reconstruction: { schema_version: 'strategy-decision-pit-reconstruction-v5', no_lookahead: true, knowledge_cutoff: '2026-01-01' },
  feature_ref_diagnostics: { refs: [null, false, 0], pass: true },
  evaluability: { status: 'EVALUABLE' }, signal_dsl_diagnostics: { pass: false },
  base_gate_diagnostics: null, rejection_diagnostics: ['保留原因'],
}
const hotContext = { candidate: { raw_signals: { technical: 0, valid: false }, industry: '半導體', current_price: 100 }, score_v2: { score: 87 } }
const preflight = (f: ReturnType<typeof fixture>) => auditHistoricalSelectionEvidenceRecoveryPreflight(f.env.DB, {
  signalDate: '2026-01-01', producerRunId: 'fixture', asOfDate: '2026-09-30', artifactEvidence: null,
})

test('strategy archive preserves real SQL PIT readiness, fallback context and exact original R2 rows', async () => {
  const f = fixture()
  try {
    const originalContext = JSON.stringify({ ...hotContext, market: '冷資料'.repeat(3000) })
    const originalEvidence = JSON.stringify({ ...hotProof, full_decision: '完整證據'.repeat(3000) })
    f.insert('2330', originalContext, originalEvidence)
    const before = f.read('2330')
    const beforePreflight = await preflight(f)
    assert.equal(beforePreflight.pitPacketRows, 1)
    const result = await f.run()
    assert.equal(result.total_scrubbed_rows, 1)
    assert.deepEqual(await preflight(f), beforePreflight)
    const after = f.read('2330')
    const context = JSON.parse(String(after.context_json))
    const evidence = JSON.parse(String(after.evidence_json))
    for (const [key, value] of Object.entries(hotContext)) assert.deepEqual(context[key], value)
    for (const [key, value] of Object.entries(hotProof)) assert.deepEqual(evidence[key], value)
    for (const column of Object.keys(before).filter(key => !['context_json', 'evidence_json'].includes(key))) assert.equal(after[column], before[column])
    for (const column of ['context_json', 'evidence_json']) {
      const pointer = JSON.parse(String(after[column]))
      const body = f.objects.get(pointer.r2_key)!
      assert.equal(await sha256Text(body), pointer.checksum)
      assert.equal(JSON.parse(body).rows[0][column], before[column])
      assert(Buffer.byteLength(String(after[column])) < Buffer.byteLength(String(before[column])))
    }
    const reclaimed = ['context_json', 'evidence_json'].reduce((sum, key) => sum + Buffer.byteLength(String(before[key])) - Buffer.byteLength(String(after[key])), 0)
    assert.equal(result.tables[0].reclaimed_blob_bytes, reclaimed)
  } finally { f.db.close() }
})

test('small siblings and existing strategy pointer identities are never enlarged or wrapped', async () => {
  const f = fixture()
  try {
    const context = JSON.stringify({ ...hotContext })
    const pointer = JSON.stringify({ schema_version: 'strategy-context-pointer-v1', r2_key: '原件'.repeat(500), context_id: 'context' })
    const evidence = JSON.stringify({ ...hotProof, audit: 'x'.repeat(6000) })
    f.insert('2330', context, evidence)
    f.insert('2331', pointer, evidence)
    const result = await f.run()
    assert.equal(result.total_scrubbed_rows, 2)
    assert.equal(f.read('2330').context_json, context)
    assert.equal(f.read('2331').context_json, pointer)
    assert.equal(JSON.parse(String(f.read('2331').evidence_json)).archived_to_r2, true)
  } finally { f.db.close() }
})

test('unprofitable retained proof advances keyset without repeated R2/manifest/source rewrites', async () => {
  const f = fixture()
  try {
    const context = JSON.stringify({ candidate: { raw_signals: '全部仍有用'.repeat(1000) } })
    const evidence = JSON.stringify({ pit_reconstruction: { ...hotProof.pit_reconstruction, full_proof: 'x'.repeat(6000) } })
    f.insert('2330', context, evidence)
    f.insert('2331', '{}', JSON.stringify({ ...hotProof, cold: 'x'.repeat(6000) }))
    const skipped = await f.run(1)
    assert.equal(skipped.tables[0].status, 'skipped')
    assert.equal(skipped.tables[0].skipped_no_savings_rows, 1)
    assert.equal(skipped.tables[0].cursor_key, '2330')
    assert.equal(skipped.tables[0].backlog_remaining, true)
    assert.deepEqual(f.stats, { puts: 0, manifests: 0, sourceUpdates: 0 })
    assert.equal((await f.run(1)).total_scrubbed_rows, 1)
    const afterUsefulWrite = { ...f.stats }
    for (let i = 0; i < 2; i++) assert.equal((await f.run(1)).total_scrubbed_rows, 0)
    assert.deepEqual(f.stats, afterUsefulWrite)
    assert.equal(f.read('2330').context_json, context)
    assert.equal(f.read('2330').evidence_json, evidence)
  } finally { f.db.close() }
})

test('large pre-existing pointers and malformed strategy JSON cause no archive rewrites', async () => {
  const f = fixture()
  try {
    const context = JSON.stringify({ schema_version: 'strategy-context-pointer-v1', r2_key: 'x'.repeat(1600) })
    const evidence = JSON.stringify({ schema_version: 'strategy-evidence-pointer-v1', ...hotProof, r2_key: 'x'.repeat(1600) })
    f.insert('2330', context, evidence)
    f.insert('2331', '{broken'.repeat(500), '{}')
    for (let i = 0; i < 4; i++) {
      const result = await f.run()
      assert.equal(result.total_archived_rows, 0)
      assert.equal(result.tables[0].skipped_no_savings_rows ?? 0, result.tables[0].candidate_rows)
      assert.equal(result.tables[0].backlog_remaining, false)
    }
    assert.equal(f.read('2330').context_json, context)
    assert.equal(f.read('2330').evidence_json, evidence)
    assert.deepEqual(f.stats, { puts: 0, manifests: 0, sourceUpdates: 0 })
  } finally { f.db.close() }
})

test('mixed page counts only changed rows and never synthesizes missing PIT proof', async () => {
  const f = fixture()
  try {
    f.insert('2330', '{}', JSON.stringify({ audit: 'x'.repeat(6000) }))
    const retained = JSON.stringify({ ...hotProof, rejection_diagnostics: 'x'.repeat(6000) })
    f.insert('2331', '{}', retained)
    const before = await preflight(f)
    const result = await f.run()
    assert.equal(result.tables[0].candidate_rows, 2)
    assert.equal(result.total_archived_rows, 2)
    assert.equal(result.total_scrubbed_rows, 1)
    assert.equal(result.tables[0].skipped_no_savings_rows, 1)
    assert.equal(f.read('2331').evidence_json, retained)
    assert.deepEqual(await preflight(f), before)
    assert.equal(JSON.parse(String(f.read('2330').evidence_json)).pit_reconstruction, undefined)
  } finally { f.db.close() }
})

test('strategy proof preservation keeps the complete original-value CAS', async () => {
  const f = fixture()
  try {
    const evidence = JSON.stringify({ ...hotProof, audit: 'x'.repeat(6000) })
    f.insert('2330', '{}', evidence)
    f.state.onPut = () => { f.db.prepare('UPDATE strategy_decision_log SET evidence_json=? WHERE decision_id=?').run('{"newer":true}', '2330') }
    const result = await f.run()
    assert.match(result.tables[0].error!, /audit_json_phase=scrub audit_json_source_changed_before_scrub/)
    assert.equal(f.read('2330').evidence_json, '{"newer":true}')
    assert.equal(result.tables[0].reclaimed_blob_bytes, undefined)
    const metadata = JSON.parse(String(f.db.prepare('SELECT metadata_json FROM dataset_snapshots').get()!.metadata_json))
    assert(metadata.planned_reclaimed_blob_bytes > 0)
    assert.equal(metadata.reclaimed_blob_bytes, undefined)
  } finally { f.db.close() }
})

for (const address of ['legacy', 'checksum'] as const) test(`real screener resolver accepts ${address} identity and rejects contradictory manifest`, async () => {
  const f = fixture()
  try {
    const evidence = JSON.stringify({ score_components: { score: 85 }, audit: 'x'.repeat(6000) })
    f.db.prepare(`INSERT INTO screener_funnel_items(id,run_id,date,symbol,stage,decision,reason_code,evidence)
      VALUES(1,'source-run','2026-01-01','2330','scoring','pass','ok',?)`).run(evidence)
    const run = await runAuditJsonArchiveRetention(f.env, {
      businessDate: '2026-09-30', runId: 'archive-run', targets: ['screener_funnel_items'],
      dryRun: false, confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
    })
    assert.equal(run.total_scrubbed_rows, 1)
    const pointer = JSON.parse(String(f.db.prepare('SELECT evidence FROM screener_funnel_items WHERE id=1').get()!.evidence))
    if (address === 'checksum') {
      const snapshotId = `d1_audit_json_archive:screener_funnel_items:${pointer.checksum}`
      const key = `archives/d1_audit_json_archive/target=screener_funnel_items/${pointer.checksum.slice(7)}.json`
      f.objects.set(key, f.objects.get(pointer.r2_key)!)
      f.db.prepare('UPDATE dataset_snapshots SET snapshot_id=?,r2_key=? WHERE snapshot_id=?').run(snapshotId, key, pointer.snapshot_id)
      pointer.snapshot_id = snapshotId; pointer.r2_key = key
    }
    const request = { ...pointer, artifact_id: pointer.snapshot_id, source_run_id: 'source-run', row_ids: [1] }
    const resolved = await resolveScreenerEvidence(f.env, [request])
    assert.equal(resolved.rows[0].evidence, evidence)
    f.db.prepare("UPDATE dataset_snapshots SET metadata_json=json_set(metadata_json,'$.target','strategy_decision_log') WHERE snapshot_id=?").run(pointer.snapshot_id)
    await assert.rejects(resolveScreenerEvidence(f.env, [request]), /manifest_identity_mismatch/)
  } finally { f.db.close() }
})
