import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { sha256Text } from './datasetSnapshots'
import { restoreArchivedFunnelEvidence } from './screenerEvidenceResolver'
import { loadFunnelStageStrategyRows } from './funnelStageStrategyRows'
import { repairHistoricalSelectionReferences } from './selectionReferenceRepair'

const RUN = 'screener-2026-09-15-canonical'
const DATE = '2026-09-15'
const TABLES: Array<[string, string]> = [
  ['ops', 'canonical_run_heads'], ['ops', 'pipeline_runs'], ['ops', 'screener_funnel_runs'], ['ops', 'run_artifacts'],
  ['ops', 'screener_funnel_items'], ['learning', 'selection_reference_snapshots_v1'],
  ['learning', 'selection_reference_repair_runs_v1'], ['learning', 'dataset_snapshots'], ['core', 'stocks'],
  ['market', 'stock_prices'],
]

function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const [domain, table] of TABLES) {
    const ddl = readFileSync(`domain-schemas/${domain}.sql`, 'utf8')
      .match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert(ddl, table); db.exec(ddl[0])
  }
  function prepare(sql: string) {
    let params: any[] = []
    return { bind(...values: any[]) { params = values; return this },
      async first() { return db.prepare(sql).get(...params) ?? null },
      async all() { return { results: db.prepare(sql).all(...params) } },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } } } }
  }
  const adapter = { prepare, async batch(statements: Array<{ run(): Promise<any> }>) {
    const out = []; for (const statement of statements) out.push(await statement.run()); return out
  } } as unknown as D1Database
  const objects = new Map<string, string>()
  const env = { DB: adapter, ARTIFACTS: { async get(key: string) {
    const body = objects.get(key); return body == null ? null : { text: async () => body }
  } } } as any
  db.prepare(`INSERT INTO screener_funnel_runs(run_id, date, status, candidate_count) VALUES(?, ?, 'success', 2)`).run(RUN, DATE)
  const insert = (symbol: string, stage: string, decision: string, evidence: unknown) => Number(db.prepare(`
    INSERT INTO screener_funnel_items(run_id, date, symbol, name, stage, decision, reason_code, score_after, evidence)
    VALUES(?, ?, ?, ?, ?, ?, 'fixture', 70, ?)`).run(RUN, DATE, symbol, symbol, stage, decision, JSON.stringify(evidence)).lastInsertRowid)
  /** Mirrors auditJsonArchive: R2 pre-image chunk, learning manifest, pointer left in D1. */
  async function archive(ids: number[], tamper?: (rows: any[]) => void) {
    const rows = ids.map((id) => ({ ...db.prepare('SELECT * FROM screener_funnel_items WHERE id=?').get(id) as any }))
    tamper?.(rows)
    const target = 'canonical_screener_funnel_items'
    const payload = { schema_version: 'd1-audit-json-archive-v1', archive_kind: 'd1_audit_json_archive', target,
      table: 'screener_funnel_items', key_column: 'id', blob_columns: ['evidence'], row_count: rows.length, rows }
    const body = JSON.stringify(payload)
    const checksum = await sha256Text(body)
    const chunk = `${ids[0]}-${ids.at(-1)}`
    const key = `archives/d1_audit_json_archive/target=${target}/business_date=2026-10-20/chunk=${chunk}-${checksum}.json`
    const snapshotId = `d1_audit_json_archive:${target}:2026-10-20:retention-run:${chunk}:${checksum}`
    objects.set(key, body)
    db.prepare(`INSERT INTO dataset_snapshots(snapshot_id, kind, business_date, schema_version, row_count, checksum,
      primary_store, access_tier, r2_key, producer_run_id, status, metadata_json)
      VALUES(?, 'd1_audit_json_archive', '2026-10-20', 'd1-audit-json-archive-v1', ?, ?, 'r2', 'archive', ?, 'retention-run', 'ready', ?)`)
      .run(snapshotId, rows.length, checksum, key, JSON.stringify({ table: 'screener_funnel_items', target,
        key_column: 'id', blob_columns: ['evidence'] }))
    for (const id of ids) {
      db.prepare('UPDATE screener_funnel_items SET evidence=? WHERE id=?').run(JSON.stringify({
        schema_version: 'd1-audit-json-pointer-v1', archived_to_r2: true, archive_kind: 'd1_audit_json_archive',
        table: 'screener_funnel_items', key_column: 'id', key_value: id, blob_column: 'evidence',
        snapshot_id: snapshotId, r2_key: key, checksum, archived_at: '2026-10-20T00:00:00Z', original_byte_length: 2048,
      }), id)
    }
    return { key }
  }
  const rows = (where = '1=1') => db.prepare(`SELECT id, run_id, stage, symbol, evidence FROM screener_funnel_items WHERE ${where} ORDER BY id`).all() as any[]
  return { db, env, objects, insert, archive, rows }
}

const scoreV2 = (value: number) => ({ score_components: { version: 'score_v2', components: { technicalStructure: value } } })

test('restore swaps any-stage pointers for the verified pre-image and passes the rest through', async () => {
  const f = fixture()
  const plain = f.insert('2330', 'final_selection', 'selected', { strategy_pool_ids: ['a'] })
  const archived = f.insert('2317', 'strategy_pool_ml_queue', 'pass', { strategy_pool_ids: ['c'], note: 'original' })
  const untouched = f.rows()
  assert.equal(await restoreArchivedFunnelEvidence(f.env, untouched), untouched)
  await f.archive([archived])
  const restored = await restoreArchivedFunnelEvidence(f.env, f.rows())
  assert.deepEqual(restored.map((row) => [row.id, JSON.parse(row.evidence)]), [
    [plain, { strategy_pool_ids: ['a'] }], [archived, { strategy_pool_ids: ['c'], note: 'original' }]])
  const forged = f.rows().map((row) => row.id === archived ? { ...row, run_id: 'other-run' } : row)
  await assert.rejects(restoreArchivedFunnelEvidence(f.env, forged), /row_identity_mismatch/)
  const moved = f.rows().map((row) => row.id === archived ? { ...row, id: plain } : row)
  await assert.rejects(restoreArchivedFunnelEvidence(f.env, moved), /pointer_invalid/)
  await assert.rejects(restoreArchivedFunnelEvidence(f.env, f.rows(), { limit: 0 }), /archive_limit/)
  for (const [key, body] of f.objects) f.objects.set(key, body + ' ')
  await assert.rejects(restoreArchivedFunnelEvidence(f.env, f.rows()), /checksum_mismatch/)
})

test('pipeline stage strategies read archived evidence and degrade to today\'s view without it', async () => {
  const f = fixture()
  f.insert('2330', 'l1_candidate_seed_after_overlay', 'selected', { strategy_pool_ids: ['a', 'b'] })
  f.insert('2330', 'l1_candidate_seed_after_overlay', 'pass', { strategy_ids: ['a'] })
  f.insert('1101', 'l1_candidate_seed_after_overlay', 'pass', { strategy_pool_ids: [] })
  f.insert('2603', 'l1_candidate_seed_after_overlay', 'drop', { strategy_pool_ids: ['z'] })
  const archived = f.insert('2317', 'l1_candidate_seed_after_overlay', 'pass', { strategy_pool_ids: ['c', null] })
  const dropped = f.insert('2454', 'l1_candidate_seed_after_overlay', 'drop', { strategy_pool_ids: ['y'] })
  await f.archive([archived, dropped])
  const pairs = async (env: any) => {
    const stage = await loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'l1_candidate_seed_after_overlay')
    return [stage.rows.map((row) => `${row.symbol}:${row.strategy_id}`).sort(), stage.archived_unresolved]
  }
  assert.deepEqual(await pairs(f.env), [['2317:c', '2330:a', '2330:b'], 0])
  // Unreadable archive: the archived item is reported as unresolved, never silently dropped.
  assert.deepEqual(await pairs(null), [['2330:a', '2330:b'], 1])
  for (const [key, body] of f.objects) f.objects.set(key, body + ' ')
  assert.deepEqual(await pairs(f.env), [['2330:a', '2330:b'], 1])
})

test('scalar strategy ids keep the old inner-join SQL result and never leave D1 as evidence', async () => {
  const f = fixture()
  f.insert('2330', 'final_selection', 'selected', { strategy_pool_ids: 7, note: 'x'.repeat(4096) })
  f.insert('2317', 'final_selection', 'selected', { strategy_ids: ['momentum'] })
  f.insert('1101', 'final_selection', 'pass', { strategy_pool_ids: ['a', 'b'] })
  const archived = f.insert('2454', 'final_selection', 'pass', { strategy_pool_ids: 9 })
  // Pre-archive SQL (JOIN json_each, no archive branch) is the reference result.
  const legacy = () => (f.db.prepare(`
    SELECT DISTINCT i.symbol, CAST(strategy.value AS TEXT) AS strategy_id
      FROM screener_funnel_items i
      JOIN json_each(CASE WHEN json_valid(i.evidence) THEN COALESCE(json_extract(i.evidence, '$.strategy_pool_ids'),
        json_extract(i.evidence, '$.strategy_ids'), json('[]')) ELSE json('[]') END) AS strategy
     WHERE i.run_id = ? AND i.stage = 'final_selection' AND i.decision IN ('selected', 'pass', 'observe')
       AND strategy.value IS NOT NULL`).all(RUN) as any[]).map((row) => `${row.symbol}:${row.strategy_id}`).sort()
  const expected = legacy()
  assert.deepEqual(expected, ['1101:a', '1101:b', '2317:momentum', '2330:7', '2454:9'])
  let pointerOnly = true
  const db = { prepare(sql: string) {
    const statement = f.env.DB.prepare(sql)
    return { ...statement, bind(...values: any[]) { statement.bind(...values); return this },
      async all() {
        const result = await statement.all()
        for (const row of result.results) if (row.archived_evidence != null && !row.archived_evidence.includes('pointer')) pointerOnly = false
        return result
      } }
  } } as any
  const stage = async () => (await loadFunnelStageStrategyRows(db, f.env, RUN, 'final_selection'))
  const current = await stage()
  assert.deepEqual(current.rows.map((row) => `${row.symbol}:${row.strategy_id}`).sort(), expected)
  assert.equal(current.archived_unresolved, 0)
  assert(pointerOnly, 'only archive pointers may come back as evidence')
  // A scalar in the archived pre-image is read back the same way.
  await f.archive([archived])
  const restored = await stage()
  assert.deepEqual(restored.rows.map((row) => `${row.symbol}:${row.strategy_id}`).sort(), expected)
  assert.equal(restored.archived_unresolved, 0)
  assert(pointerOnly)
})

test('one request reads each verified archive chunk once across calls', async () => {
  const f = fixture()
  const a = f.insert('2330', 'l1_candidate_seed_after_overlay', 'pass', { strategy_pool_ids: ['a'] })
  const b = f.insert('2330', 'final_selection', 'selected', { strategy_pool_ids: ['b'] })
  const c = f.insert('2317', 'final_selection', 'selected', { strategy_pool_ids: ['c'] })
  await f.archive([a, b, c])
  let reads = 0
  const get = f.env.ARTIFACTS.get
  const env = { ...f.env, ARTIFACTS: { async get(key: string) { reads += 1; return get(key) } } }
  const chunks = new Map()
  const [router, final] = await Promise.all([
    loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'l1_candidate_seed_after_overlay', chunks),
    loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'final_selection', chunks),
  ])
  for (const symbols of [['2330'], ['2317']]) {
    await restoreArchivedFunnelEvidence(env, f.rows(`symbol IN ('${symbols.join("','")}')`), { chunks })
  }
  assert.equal(reads, 1)
  assert.deepEqual([router.rows, final.rows.map((row) => row.strategy_id).sort()], [
    [{ symbol: '2330', strategy_id: 'a' }], ['b', 'c']])
  // Without a shared cache every call verifies the chunk again (no cross-request reuse).
  await restoreArchivedFunnelEvidence(env, f.rows())
  assert.equal(reads, 2)
})

test('historical selection repair reads archived scoring evidence and stays fail-closed', async () => {
  const setup = async (archivedEvidence: unknown = scoreV2(9)) => {
    const f = fixture()
    f.db.exec(`INSERT INTO canonical_run_heads(logical_run_key, run_id, promoted_at)
      VALUES('screener:${DATE}:TW:production:market_screener', '${RUN}', '${DATE}');
      INSERT INTO pipeline_runs(run_id, logical_run_key, domain, business_date, stage, status, input_fingerprint, code_version, config_version)
      VALUES('${RUN}', 'screener:${DATE}', 'screener', '${DATE}', 'final', 'canonical', 'f', 'c', 'c');
      INSERT INTO run_artifacts(artifact_id, retention_class, status, domain, business_date, producer_run_id, r2_key,
        checksum, schema_version, created_at, checksum_verified_at)
      VALUES('artifact:screener_funnel:${DATE}', 'canonical_execution', 'ready', 'screener_funnel', '${DATE}', '${RUN}',
        'artifacts/funnel.json', 'sha256:artifact', 'screener-funnel-evidence-v3', '${DATE}', '${DATE}');
      INSERT INTO stocks(id, symbol, name) VALUES(1, '2330', 'TSMC'), (2, '2317', 'Hon Hai');`)
    f.insert('2330', 'scoring', 'pass', scoreV2(8))
    const archived = f.insert('2317', 'scoring', 'pass', archivedEvidence)
    await f.archive([archived])
    return { f, archived }
  }
  const { f } = await setup()
  await assert.rejects(repairHistoricalSelectionReferences(f.env.DB, DATE, { dryRun: true }),
    /selection_reference_repair_archived_evidence_unavailable/)
  assert.equal((await repairHistoricalSelectionReferences(f.env.DB, DATE, { dryRun: true, archiveEnv: f.env })).expected_rows, 2)
  const result = await repairHistoricalSelectionReferences(f.env.DB, DATE, { archiveEnv: f.env })
  assert.equal(result.persisted_rows, 2)
  const written = f.db.prepare(`SELECT symbol, feature_available, score_components FROM selection_reference_snapshots_v1
    ORDER BY symbol`).all() as any[]
  assert.deepEqual(written.map((row) => [row.symbol, row.feature_available, JSON.parse(row.score_components).components]), [
    ['2317', 1, { technicalStructure: 9 }], ['2330', 1, { technicalStructure: 8 }]])

  const missing = await setup({ score_components: { version: 'legacy' } })
  await assert.rejects(repairHistoricalSelectionReferences(missing.f.env.DB, DATE, { dryRun: true, archiveEnv: missing.f.env }),
    /selection_reference_repair_scoring_coverage_mismatch:2\/2\/2\/2\/1\/2/)
  const tampered = await setup()
  for (const [key, body] of tampered.f.objects) tampered.f.objects.set(key, body + ' ')
  await assert.rejects(repairHistoricalSelectionReferences(tampered.f.env.DB, DATE, { archiveEnv: tampered.f.env }),
    /checksum_mismatch/)
  assert.equal(Number((tampered.f.db.prepare('SELECT COUNT(*) n FROM selection_reference_snapshots_v1').get() as any).n), 0)
})
