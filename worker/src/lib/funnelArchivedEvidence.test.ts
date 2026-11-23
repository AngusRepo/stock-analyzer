import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { sha256Text } from './datasetSnapshots'
import { FunnelArchiveReader, restoreArchivedFunnelEvidence, scanAuditArchiveBody, visitArchivedFunnelEvidence } from './screenerEvidenceResolver'
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

function d1(db: DatabaseSync): D1Database {
  function prepare(sql: string) {
    let params: any[] = []
    return { bind(...values: any[]) { params = values; return this },
      async first() { return db.prepare(sql).get(...params) ?? null },
      async all() { return { results: db.prepare(sql).all(...params) } },
      async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...params).changes) } } } }
  }
  return { prepare, async batch(statements: Array<{ run(): Promise<any> }>) {
    const out = []; for (const statement of statements) out.push(await statement.run()); return out
  } } as unknown as D1Database
}

/** One legacy D1 by default; `split` gives each domain its own D1 (prod MULTI_D1_ACTIVE_DOMAINS). */
function fixture({ split = false } = {}) {
  const databases = new Map<string, DatabaseSync>()
  const domainDb = (domain: string) => {
    const key = split ? domain : 'legacy'
    if (!databases.has(key)) databases.set(key, new DatabaseSync(':memory:'))
    return databases.get(key)!
  }
  for (const [domain, table] of TABLES) {
    const ddl = readFileSync(`domain-schemas/${domain}.sql`, 'utf8')
      .match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert(ddl, table); domainDb(domain).exec(ddl[0])
    // The frozen legacy D1 keeps the same tables (and none of the domain rows).
    if (split) domainDb('legacy').exec(ddl[0])
  }
  const db = domainDb('ops')
  const learning = domainDb('learning')
  const objects = new Map<string, string>()
  const artifacts = { async get(key: string) {
    // R2ObjectBody reports its byte size before the body is read.
    const body = objects.get(key); return body == null ? null : { size: new TextEncoder().encode(body).length, text: async () => body }
  } }
  const env = (split ? { DB: d1(domainDb('legacy')), OPS_DB: d1(db), CORE_DB: d1(domainDb('core')),
    LEARNING_DB: d1(learning), MARKET_DB: d1(domainDb('market')), MULTI_D1_ACTIVE_DOMAINS: 'ops,core,learning,market',
    ARTIFACTS: artifacts } : { DB: d1(db), ARTIFACTS: artifacts }) as any
  const repairDbs = split
    ? { opsDb: env.OPS_DB, coreDb: env.CORE_DB, learningDb: env.LEARNING_DB }
    : { opsDb: env.DB, coreDb: env.DB, learningDb: env.DB }
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
    learning.prepare(`INSERT INTO dataset_snapshots(snapshot_id, kind, business_date, schema_version, row_count, checksum,
      primary_store, access_tier, r2_key, producer_run_id, status, metadata_json)
      VALUES(?, 'd1_audit_json_archive', '2026-10-20', 'd1-audit-json-archive-v1', ?, ?, 'r2', 'archive', ?, 'retention-run', 'ready', ?)`)
      .run(snapshotId, rows.length, checksum, key, JSON.stringify({ table: 'screener_funnel_items', target,
        key_column: 'id', blob_columns: ['evidence'],
        archived_blob_bytes: rows.reduce((sum, row) => sum + new TextEncoder().encode(row.evidence).length, 0) }))
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
  return { db, learning, core: domainDb('core'), legacy: domainDb('legacy'), env, repairDbs, objects, insert, archive, rows }
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
  const reader = new FunnelArchiveReader(env)
  const [router, final] = await Promise.all([
    loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'l1_candidate_seed_after_overlay', reader),
    loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'final_selection', reader),
  ])
  assert.equal(reads, 1)
  assert.equal(reader.fetches, 1)
  assert.deepEqual([router.rows, final.rows.map((row) => row.strategy_id).sort()], [
    [{ symbol: '2330', strategy_id: 'a' }], ['b', 'c']])
  // Without a shared reader every call verifies the chunk again (no cross-request reuse).
  await restoreArchivedFunnelEvidence(env, f.rows())
  assert.equal(reads, 2)
})

test('a historical stage spanning more retention chunks than one slice reads back whole', async () => {
  // Prod 10-19: final_selection's 744 rows span 26 retention chunks; one chunk per row here.
  const f = fixture()
  const ids = Array.from({ length: 26 }, (_, i) =>
    f.insert(String(1100 + i), 'final_selection', 'selected', { strategy_pool_ids: [`s${i}`] }))
  for (const id of ids) await f.archive([id])
  const stage = await loadFunnelStageStrategyRows(f.env.DB, f.env, RUN, 'final_selection')
  assert.equal(stage.archived_unresolved, 0)
  assert.equal(stage.rows.length, 26)
  const restored = await restoreArchivedFunnelEvidence(f.env, f.rows())
  assert.deepEqual(restored.map((row) => JSON.parse(row.evidence).strategy_pool_ids[0]), ids.map((_, i) => `s${i}`))
})

test('historical selection repair reads the domain D1s, archived scoring evidence, and stays fail-closed', async () => {
  const setup = async (archivedEvidence: unknown = scoreV2(9)) => {
    const f = fixture({ split: true })
    f.db.exec(`INSERT INTO canonical_run_heads(logical_run_key, run_id, promoted_at)
      VALUES('screener:${DATE}:TW:production:market_screener', '${RUN}', '${DATE}');
      INSERT INTO pipeline_runs(run_id, logical_run_key, domain, business_date, stage, status, input_fingerprint, code_version, config_version)
      VALUES('${RUN}', 'screener:${DATE}', 'screener', '${DATE}', 'final', 'canonical', 'f', 'c', 'c');
      INSERT INTO run_artifacts(artifact_id, retention_class, status, domain, business_date, producer_run_id, r2_key,
        checksum, schema_version, created_at, checksum_verified_at)
      VALUES('artifact:screener_funnel:${DATE}', 'canonical_execution', 'ready', 'screener_funnel', '${DATE}', '${RUN}',
        'artifacts/funnel.json', 'sha256:artifact', 'screener-funnel-evidence-v3', '${DATE}', '${DATE}');`)
    f.core.exec(`INSERT INTO stocks(id, symbol, name, market, sector) VALUES(1, '2330', 'TSMC', 'TWSE', 'semi'), (2, '2317', 'Hon Hai', 'TWSE', 'ems');`)
    f.insert('2330', 'scoring', 'pass', scoreV2(8))
    const archived = f.insert('2317', 'scoring', 'pass', archivedEvidence)
    await f.archive([archived])
    return { f, archived }
  }
  const { f } = await setup()
  await assert.rejects(repairHistoricalSelectionReferences(f.repairDbs, DATE, { dryRun: true }),
    /selection_reference_repair_archived_evidence_unavailable/)
  assert.equal((await repairHistoricalSelectionReferences(f.repairDbs, DATE, { dryRun: true, archiveEnv: f.env })).expected_rows, 2)
  const result = await repairHistoricalSelectionReferences(f.repairDbs, DATE, { archiveEnv: f.env })
  assert.equal(result.persisted_rows, 2)
  const written = f.learning.prepare(`SELECT symbol, stock_id, market_segment, sector, feature_available, score_components
    FROM selection_reference_snapshots_v1 ORDER BY symbol`).all() as any[]
  assert.deepEqual(written.map((row) => [row.symbol, row.stock_id, row.market_segment, row.sector, row.feature_available,
    JSON.parse(row.score_components).components]), [
    ['2317', 2, 'TWSE', 'ems', 1, { technicalStructure: 9 }], ['2330', 1, 'TWSE', 'semi', 1, { technicalStructure: 8 }]])
  assert.equal((f.learning.prepare(`SELECT status FROM selection_reference_repair_runs_v1`).get() as any).status, 'ready')
  // The frozen legacy D1 is neither the source nor the target.
  assert.equal(Number((f.legacy.prepare('SELECT COUNT(*) n FROM selection_reference_snapshots_v1').get() as any).n), 0)

  const missing = await setup({ score_components: { version: 'legacy' } })
  await assert.rejects(repairHistoricalSelectionReferences(missing.f.repairDbs, DATE, { dryRun: true, archiveEnv: missing.f.env }),
    /selection_reference_repair_scoring_coverage_mismatch:2\/2\/2\/2\/1\/2/)
  const unknownStock = await setup()
  unknownStock.f.core.exec(`DELETE FROM stocks WHERE symbol='2330'`)
  await assert.rejects(repairHistoricalSelectionReferences(unknownStock.f.repairDbs, DATE, { archiveEnv: unknownStock.f.env }),
    /selection_reference_repair_stock_identity_missing:2330/)
  const tampered = await setup()
  for (const [key, body] of tampered.f.objects) tampered.f.objects.set(key, body + ' ')
  await assert.rejects(repairHistoricalSelectionReferences(tampered.f.repairDbs, DATE, { archiveEnv: tampered.f.env }),
    /checksum_mismatch/)
  assert.equal(Number((tampered.f.learning.prepare('SELECT COUNT(*) n FROM selection_reference_snapshots_v1').get() as any).n), 0)
})

/**
 * A historical day as prod retention cut it: rows archived in id order, `perChunk` rows per
 * chunk, stage-major, so every 36-symbol slice spans many chunks (prod 10-19: 18-24 per slice,
 * 26 per stage, 72 per run). Returns the full-view flow's read count and outputs.
 */
async function historicalDay(chunkCount: number, options: { reader?: (env: any) => FunnelArchiveReader } = {}) {
  const f = fixture()
  const stages = ['scoring', 'l15_ml_slate_queue', 'layer3_formal_ml_gate', 'l1_candidate_seed_after_overlay', 'final_selection']
  const perChunk = 10
  const symbols = Array.from({ length: (chunkCount * perChunk) / stages.length }, (_, i) => String(1000 + i))
  const ids: number[] = []
  for (const stage of stages) {
    for (const symbol of symbols) {
      ids.push(f.insert(symbol, stage, 'pass', { strategy_pool_ids: [`${stage}:${symbol}`], vector: 'v'.repeat(512) }))
    }
  }
  for (let i = 0; i < ids.length; i += perChunk) await f.archive(ids.slice(i, i + perChunk))
  let reads = 0
  const get = f.env.ARTIFACTS.get
  const env = { ...f.env, ARTIFACTS: { async get(key: string) { reads += 1; return get(key) } } }
  const reader = options.reader?.(env) ?? new FunnelArchiveReader(env)
  // Full view: 36-symbol slices of D1 rows, then one verified pass over every archived row.
  const sliceChunks: number[] = []
  const archived: any[] = []
  for (let i = 0; i < symbols.length; i += 36) {
    const slice = f.rows(`symbol IN ('${symbols.slice(i, i + 36).join("','")}')`)
    sliceChunks.push(new Set(slice.map((row) => JSON.parse(row.evidence).snapshot_id)).size)
    archived.push(...slice)
  }
  const restored: any[] = archived.slice()
  let restoreError: unknown = null
  try {
    await visitArchivedFunnelEvidence(env, archived, (index, row, _text, evidence) => { restored[index] = { ...row, evidence } }, { reader })
  } catch (error) { restoreError = error }
  const [router, final] = await Promise.all([
    loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'l1_candidate_seed_after_overlay', reader),
    loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'final_selection', reader),
  ])
  return { f, reads, reader, symbols, sliceChunks, archived, restored, restoreError, router, final }
}

for (const chunkCount of [26, 72]) {
  test(`a ${chunkCount}-chunk historical day reads back whole, each chunk fetched once`, async () => {
    const day = await historicalDay(chunkCount)
    assert.equal(day.restoreError, null)
    // Several slices already span more chunks than the old per-call limit of 16.
    assert(Math.max(...day.sliceChunks) > 16, `slice chunks ${day.sliceChunks}`)
    assert.equal(day.restored.length, chunkCount * 10)
    for (const row of day.restored) assert.deepEqual(row.evidence.strategy_pool_ids, [`${row.stage}:${row.symbol}`])
    assert.deepEqual([day.router.archived_unresolved, day.final.archived_unresolved], [0, 0])
    assert.equal(day.router.rows.length, day.symbols.length)
    assert.equal(day.final.rows.length, day.symbols.length)
    // Every slice and both stages share one R2 read per chunk.
    assert.equal(day.reads, chunkCount)
    assert.equal(day.reader.fetches, chunkCount)
  })
}

test('the pipeline stages alone read each chunk they use once', async () => {
  const day = await historicalDay(26)
  // Pipeline view (no restore pass): both stages share one read per chunk they use.
  const stagesOnly = new FunnelArchiveReader(day.f.env)
  const [router, final] = await Promise.all([
    loadFunnelStageStrategyRows(day.f.env.DB, day.f.env, RUN, 'l1_candidate_seed_after_overlay', stagesOnly),
    loadFunnelStageStrategyRows(day.f.env.DB, day.f.env, RUN, 'final_selection', stagesOnly),
  ])
  assert.deepEqual([router.archived_unresolved, final.archived_unresolved], [0, 0])
  const used = new Set(day.f.rows(`stage IN ('l1_candidate_seed_after_overlay','final_selection')`)
    .map((row) => JSON.parse(row.evidence).snapshot_id))
  assert.equal(stagesOnly.fetches, used.size)
})

test('over the byte budget the archive is reported unresolved, never thrown or read whole', async () => {
  // Request budget below one historical day: the stages degrade, the restore fails closed.
  const tight = await historicalDay(26, { reader: (env) => new FunnelArchiveReader(env, { requestBytes: 64 * 1024 }) })
  assert.match(String(tight.restoreError), /audit_evidence_archive_request_bytes/)
  assert(tight.reader.bytesRead <= 64 * 1024)
  assert.equal(tight.router.archived_unresolved, tight.symbols.length)
  assert.equal(tight.final.archived_unresolved, tight.symbols.length)
  // A chunk over the per-chunk cap is refused from its manifest, before any R2 read.
  const big = await historicalDay(26, { reader: (env) => new FunnelArchiveReader(env, { chunkBytes: 1024 }) })
  assert.match(String(big.restoreError), /audit_evidence_archive_chunk_bytes/)
  assert.equal(big.reads, 0)
  assert.deepEqual([big.router.archived_unresolved, big.final.archived_unresolved], [big.symbols.length, big.symbols.length])
  // Manifest understating the size: R2's reported size still stops the read.
  const f = fixture()
  const id = f.insert('2330', 'final_selection', 'selected', { strategy_pool_ids: ['a'], blob: 'x'.repeat(4096) })
  await f.archive([id])
  f.learning.exec(`UPDATE dataset_snapshots SET metadata_json=json_set(metadata_json, '$.archived_blob_bytes', 1)`)
  let textReads = 0
  const get = f.env.ARTIFACTS.get
  const env = { ...f.env, ARTIFACTS: { async get(key: string) {
    const object = await get(key); return object && { size: object.size, text: async () => { textReads += 1; return object.text() } }
  } } }
  const stage = await loadFunnelStageStrategyRows(f.env.DB, env, RUN, 'final_selection', new FunnelArchiveReader(env, { chunkBytes: 1024 }))
  assert.equal(stage.archived_unresolved, 1)
  assert.equal(textReads, 0)
})

test('the row-by-row body scan equals JSON.parse on tricky bodies and rejects malformed ones', () => {
  const tricky = ['"', '\\', '\\"', '\\\\"', '{"a":[1,]}', '}]', '[{', '中文 "引號" \\u0000', '😀', ' ', ',:']
  const rows = tricky.map((text, i) => ({ id: i + 1, run_id: `r${text}`, stage: 'final_selection', symbol: String(1101 + i),
    evidence: JSON.stringify({ note: text, nested: { list: [text, { deeper: [text] }], n: -1.5e-7, t: true, z: null } }) }))
  const header = { schema_version: 'v', rows_note: '"rows":[', nested: { rows: [1, 2] }, row_count: rows.length }
  for (const body of [
    JSON.stringify({ ...header, rows }),
    JSON.stringify({ rows, ...header }, null, 2),
    JSON.stringify({ ...header, rows: [] }),
    `\n { "rows" : [ ${rows.map((row) => JSON.stringify(row)).join(' ,\n')} ] , "row_count" : ${rows.length} }\t`,
  ]) {
    const seen: any[] = []
    const scanned = scanAuditArchiveBody(new TextEncoder().encode(body), (row) => seen.push(row))
    const parsed = JSON.parse(body)
    assert.deepEqual(seen, parsed.rows)
    assert.equal(scanned.rows, parsed.rows.length)
    for (const key of Object.keys(parsed)) if (key !== 'rows') assert.deepEqual(scanned[key], parsed[key])
  }
  const good = JSON.stringify({ ...header, rows })
  for (const bad of [good.slice(0, -1), good + 'x', good.slice(0, good.length / 2), `{"rows":[],"rows":[]}`,
    `{"rows":[{"id":1},]}`, `{"rows":[{"id":1}{"id":2}]}`, `[${good}]`, '', `{"a":1 "b":2}`, `{"a":}`]) {
    assert.throws(() => scanAuditArchiveBody(new TextEncoder().encode(bad), () => {}), bad.slice(0, 40))
  }
  // Invalid UTF-8 is refused, not decoded with replacement characters.
  const bytes = new TextEncoder().encode(good)
  bytes[good.indexOf('中')] = 0xff
  assert.throws(() => scanAuditArchiveBody(bytes, () => {}))
})
