import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runLegacyStrategyEvidenceMigration } from './legacyStrategyEvidenceMigration'

function fixture(mode: 'normal' | 'concurrent' | 'corrupt' | 'lost_ack' = 'normal') {
  const sql = new DatabaseSync(':memory:')
  for (const [domain, tables] of Object.entries({
    learning: ['strategy_decision_log', 'strategy_candidate_contexts'],
    ops: ['legacy_migration_cursors', 'run_artifacts', 'artifact_hard_references'],
  })) {
    const schema = readFileSync(`domain-schemas/${domain}.sql`, 'utf8')
    for (const table of tables) {
      const statement = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
      assert.ok(statement, table)
      sql.exec(statement[0])
    }
  }
  const pit = { schema_version: 'strategy-decision-pit-reconstruction-v5', no_lookahead: true, knowledge_cutoff: '2026-09-15' }
  const context = JSON.stringify({ candidate: { raw_signals: { momentum: 0.4 }, current_price: 30, industry: 'test' }, score_v2: 60 })
  const evidence = JSON.stringify({ pit_reconstruction: pit, evaluability: { status: 'EVALUABLE' }, large_detail: 'original'.repeat(1000) })
  sql.prepare(`INSERT INTO strategy_decision_log(decision_id,date,symbol,strategy_id,strategy_version,strategy_status,alpha_bucket,reason_code,context_json,evidence_json)
    VALUES('d1','2026-09-15','2330','s1','v1','active','core','matched',?,?)`).run(context, evidence)
  let loseAck = mode === 'lost_ack'
  function prepare(query: string) {
    let params: any[] = []
    return {
      query,
      bind(...values: any[]) { params = values; return this },
      async first() { return sql.prepare(query).get(...params) ?? null },
      async all() { return { results: sql.prepare(query).all(...params) } },
      async run() { const result = sql.prepare(query).run(...params); return { meta: { changes: Number(result.changes) } } },
    }
  }
  const db = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sql.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      sql.exec('COMMIT')
      if (loseAck && statements[0]?.query.includes('UPDATE strategy_decision_log')) {
        loseAck = false
        throw new Error('lost response')
      }
      return results
    } catch (error) { if (sql.isTransaction) sql.exec('ROLLBACK'); throw error }
  } }
  const objects = new Map<string, string>()
  const bucket = {
    async put(key: string, body: string) {
      objects.set(key, mode === 'corrupt' ? 'corrupt' : body)
      if (mode === 'concurrent') sql.prepare("UPDATE strategy_decision_log SET evidence_json=? WHERE decision_id='d1'").run('{"new_evidence":true}')
    },
    async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body } },
  }
  return { sql, objects, pit, context, evidence, env: { DB: db, ARTIFACTS: bucket } as any }
}

test('compaction preserves PIT readiness, signal inputs, and original verified evidence', async () => {
  const f = fixture()
  try {
    const result = await runLegacyStrategyEvidenceMigration(f.env)
    assert.equal(result.migrated_decisions, 1)
    const row = f.sql.prepare('SELECT * FROM strategy_decision_log').get()!
    const compact = JSON.parse(String(row.evidence_json))
    assert.deepEqual(compact.pit_reconstruction, f.pit)
    assert.deepEqual(compact.evaluability, { status: 'EVALUABLE' })
    assert.ok(String(row.evidence_json).length < f.evidence.length)
    assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM strategy_decision_log WHERE json_extract(evidence_json,'$.pit_reconstruction.no_lookahead')=1 AND json_extract(evidence_json,'$.pit_reconstruction.knowledge_cutoff')='2026-09-15'").get()?.n, 1)
    assert.equal(JSON.parse(String(f.sql.prepare('SELECT raw_signals_json FROM strategy_candidate_contexts').get()?.raw_signals_json)).momentum, 0.4)
    const archive = JSON.parse([...f.objects.values()][0])
    assert.equal(archive.payload.decisions[0].evidence_json, f.evidence)
    assert.equal(archive.payload.contexts[0].context_json, f.context)
    assert.equal(f.sql.prepare('SELECT hard_ref_count FROM run_artifacts').get()?.hard_ref_count, 1)
    assert.equal(f.sql.prepare('SELECT retention_class FROM run_artifacts').get()?.retention_class, 'ten_year_cold_archive')
    assert.ok([...f.objects.keys()][0].startsWith('evidence/class=ten_year_cold_archive/'))
  } finally { f.sql.close() }
})

test('concurrent source correction is preserved and cannot advance the cursor', async () => {
  const f = fixture('concurrent')
  try {
    await assert.rejects(runLegacyStrategyEvidenceMigration(f.env), /legacy_strategy_source_changed/)
    const row = f.sql.prepare('SELECT context_id,evidence_json FROM strategy_decision_log').get()!
    assert.equal(row.context_id, null)
    assert.equal(row.evidence_json, '{"new_evidence":true}')
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM legacy_migration_cursors').get()?.n, 0)
  } finally { f.sql.close() }
})

test('corrupt backup cannot replace any source evidence', async () => {
  const f = fixture('corrupt')
  try {
    await assert.rejects(runLegacyStrategyEvidenceMigration(f.env), /checksum_mismatch/)
    assert.equal(f.sql.prepare('SELECT evidence_json FROM strategy_decision_log').get()?.evidence_json, f.evidence)
  } finally { f.sql.close() }
})

test('lost acknowledgement retries without double-compacting or losing PIT proof', async () => {
  const f = fixture('lost_ack')
  try {
    await assert.rejects(runLegacyStrategyEvidenceMigration(f.env), /lost response/)
    const result = await runLegacyStrategyEvidenceMigration(f.env)
    assert.equal(result.migrated_decisions, 0)
    assert.equal(result.backlog_remaining, false)
    assert.deepEqual(JSON.parse(String(f.sql.prepare('SELECT evidence_json FROM strategy_decision_log').get()?.evidence_json)).pit_reconstruction, f.pit)
    assert.equal(f.objects.size, 1)
  } finally { f.sql.close() }
})


test('compaction does not fabricate a missing PIT proof', async () => {
  const f = fixture()
  try {
    f.sql.exec("UPDATE strategy_decision_log SET evidence_json='{}'")
    await runLegacyStrategyEvidenceMigration(f.env)
    assert.equal(JSON.parse(String(f.sql.prepare('SELECT evidence_json FROM strategy_decision_log').get()?.evidence_json)).pit_reconstruction, undefined)
  } finally { f.sql.close() }
})

test('historical matrix projections stay compact and do not create empty replacement signals', async () => {
  const f = fixture()
  try {
    const context = JSON.stringify({ schema_version: 'strategy-context-historical-matrix-projection-v1', source: 'canonical_strategy_label_matrix_v4' })
    const evidence = JSON.stringify({ schema_version: 'strategy-decision-historical-matrix-projection-v1', no_lookahead: true })
    f.sql.prepare('UPDATE strategy_decision_log SET context_json=?,evidence_json=?').run(context,evidence)
    const result = await runLegacyStrategyEvidenceMigration(f.env)
    assert.equal(result.migrated_decisions,0)
    assert.equal(result.artifacts,0)
    assert.equal(f.objects.size,0)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM strategy_candidate_contexts').get()?.n,0)
    assert.equal(f.sql.prepare('SELECT context_json FROM strategy_decision_log').get()?.context_json,context)
    assert.equal(f.sql.prepare('SELECT evidence_json FROM strategy_decision_log').get()?.evidence_json,evidence)
  } finally { f.sql.close() }
})

test('small source rows do not grow or acquire empty normalized replacement contexts', async()=>{
  const f=fixture()
  try {
    f.sql.exec("UPDATE strategy_decision_log SET context_json='{}',evidence_json='{}'")
    const result=await runLegacyStrategyEvidenceMigration(f.env)
    assert.equal(result.migrated_decisions,0)
    assert.equal(result.original_blob_bytes,0)
    assert.equal(result.compact_blob_bytes,0)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM strategy_candidate_contexts').get()?.n,0)
    assert.equal(f.sql.prepare('SELECT context_json FROM strategy_decision_log').get()?.context_json,'{}')
  }finally{f.sql.close()}
})
