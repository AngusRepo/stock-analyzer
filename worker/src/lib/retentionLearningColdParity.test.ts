// D1-M3 parity: run the REAL confirmed hot-window drain on a SQLite stand-in for D1 + R2, then
// prove cold read ∪ remaining hot rows == the hot read taken before the drain, column by column
// and including the original rowid. Also proves the OPS dataset gate is the only switch.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE, runRetentionHotWindowDrain } from './retentionHotWindowDrain'
import { adminReadRoutes } from '../routes/adminReadRoutes'
import { DATASET_SNAPSHOT_COLD_READ_ERROR } from './retentionDatasetSnapshotCold'
import { archivedLearningRows, findArchivedLearningRow } from './retentionLearningColdReader'
import { LEARNING_DRAIN_SPECS, resolveLearningDrainSource, S12_STRUCTURE_LIVE_SOURCES } from './retentionLearningDrainGates'
import { retentionR2PolicyConfig } from './retentionArchiveOnly'
import { releaseArchivedRows } from './retentionSourceRelease'
import { mergeArchivedS12Evidence } from './retentionS12StructureReader'
import { archivedS12ReplayChunks } from './retentionS12ReplayReader'
import { buildBoundedRetentionSelect } from './retentionExactRows'
import { sha256Text } from './datasetSnapshots'
import { S12_REPLAY_ENGINE_SIGNATURE as ENGINE } from './s12ReplayContract'
import type { Bindings } from '../types'

const BUSINESS_DATE = '2026-11-05'
const CUTOFF_120 = '2026-07-08'
const ops = readFileSync('domain-schemas/ops.sql', 'utf8')
const learning = readFileSync('domain-schemas/learning.sql', 'utf8')

function tableDdl(schema: string, table: string): string {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
  assert(start >= 0, `ddl missing: ${table}`)
  return schema.slice(start, schema.indexOf('\n);', start) + 3)
}

function fixture(learningTables: string[]) {
  const sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys=ON')
  for (const table of ['data_retention_policies', 'data_retention_runs', 'data_retention_run_items', 'data_retention_cursors',
    'run_artifacts', 'artifact_deletion_claims_v1', 'artifact_hard_references']) sql.exec(tableDdl(ops, table))
  sql.exec(`INSERT INTO data_retention_policies(policy_id,domain,dataset_pattern,hot_retention_days,cold_retention_days,
    archive_store,action,hard_reference_protected,version,status,approved_reason)
    VALUES('learning_lineage_v1','learning','predictions',120,3650,'r2','archive_delete',1,2,'active','test')`)
  sql.exec(readFileSync('domain-migrations/ops/0025_learning_m3_dataset_drain_gates.sql', 'utf8'))
  for (const table of ['predictions', ...learningTables]) sql.exec(tableDdl(learning, table))
  sql.exec(readFileSync('domain-migrations/learning/0050_retention_source_release.sql', 'utf8'))
  const objects = new Map<string, string>()
  const queries = new Set<string>()
  function prepare(query: string, params: unknown[] = []) {
    queries.add(query)
    return { query, get params() { return params }, bind(...values: unknown[]) { return prepare(query, values) },
      async first() { return sql.prepare(query).get(...(params as any[])) ?? null },
      async all() { return { results: sql.prepare(query).all(...(params as any[])) } },
      async run() { const r = sql.prepare(query).run(...(params as any[])); return { success: true, meta: { changes: Number(r.changes) } } } }
  }
  const db = { prepare, async batch(statements: any[]) {
    sql.exec('BEGIN')
    try {
      const result = statements.map(s => {
        const q = sql.prepare(s.query)
        return { results: q.columns().length ? q.all(...s.params) : (q.run(...s.params), []) }
      })
      sql.exec('COMMIT')
      return result
    } catch (error) { if (sql.isTransaction) sql.exec('ROLLBACK'); throw error }
  } } as unknown as D1Database
  const artifacts = {
    async get(key: string) { const raw = objects.get(key); return raw === undefined ? null : { size: Buffer.byteLength(raw), text: async () => raw } },
    async put(key: string, body: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }) {
      if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) throw new Error('precondition failed')
      objects.set(key, body)
    },
  }
  const env = { DB: db, ARTIFACTS: artifacts } as unknown as Bindings
  const gate = (dataset: string, days: number, action = 'archive_delete', status = 'active') => sql.prepare(`UPDATE data_retention_dataset_gates
    SET hot_retention_days=?,action=?,status=? WHERE policy_id='learning_lineage_v1' AND dataset_id=?`).run(days, action, status, dataset)
  const drain = () => runRetentionHotWindowDrain(env, { policyIds: ['learning_lineage_v1'], businessDate: BUSINESS_DATE,
    maxRounds: 10, limitPerDataset: 250, confirmPhrase: RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE })
  const hotRead = (table: string, dateColumn: string) =>
    sql.prepare(`SELECT rowid AS __rowid, * FROM ${table} ORDER BY ${dateColumn}, rowid`).all() as Record<string, unknown>[]
  return { sql, db, env, objects, gate, drain, hotRead, queries }
}

function insert(sql: DatabaseSync, table: string, row: Record<string, unknown>) {
  sql.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`)
    .run(...(Object.values(row) as any[]))
}

/** before == hot-after ∪ cold-after, by original rowid and every column. */
async function assertParity(f: ReturnType<typeof fixture>, table: string, dateColumn: string,
  before: Record<string, unknown>[], expectDeleted: number) {
  const after = f.hotRead(table, dateColumn)
  assert.equal(before.length - after.length, expectDeleted, 'deleted rows')
  const cold: Record<string, unknown>[] = []
  for await (const chunk of archivedLearningRows(f.env, f.db, table, { startDate: '2000-01-01', endDate: '2099-12-31' }))
    cold.push(...chunk.map(item => ({ __rowid: item.rowid, ...item.row })))
  assert.equal(cold.length, expectDeleted, 'cold rows')
  const byRowid = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => Number(a.__rowid) - Number(b.__rowid))
  assert.deepEqual(byRowid([...after, ...cold]).map(r => ({ ...r })), byRowid(before).map(r => ({ ...r })))
  return { after, cold }
}

test('learning_lineage_v1 gates: migration 0025 is draft-only and every gated dataset starts blocked', async () => {
  const f = fixture(['dataset_snapshots'])
  try {
    const rows = f.sql.prepare('SELECT dataset_id,hot_retention_days,action,status FROM data_retention_dataset_gates ORDER BY dataset_id').all()
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { dataset_id: 'dataset_snapshots', hot_retention_days: 120, action: 'archive_only', status: 'draft' },
      { dataset_id: 's12_replay_trade_outcomes', hot_retention_days: 120, action: 'archive_only', status: 'draft' },
      { dataset_id: 's12_structure_snapshots', hot_retention_days: 120, action: 'archive_only', status: 'draft' },
      { dataset_id: 'strategy_decision_log', hot_retention_days: 45, action: 'archive_only', status: 'draft' },
      { dataset_id: 'strategy_label_matrix_v4', hot_retention_days: 45, action: 'archive_only', status: 'draft' },
    ])
    for (const row of rows as any[]) assert.equal(LEARNING_DRAIN_SPECS[row.dataset_id].hotRetentionDays, row.hot_retention_days)
    const config = retentionR2PolicyConfig('learning_lineage_v1')!
    const gates = new Map((rows as any[]).map(r => [r.dataset_id, r]))
    const blocked = config.sources.map(s => resolveLearningDrainSource(s, gates)).filter(r => r.blockedReason)
    assert.equal(blocked.length, 10)
    // Active gate with the wrong window, or the M2 code block, never enables a drain.
    const active = (dataset: string, days: number) => new Map([[dataset, { dataset_id: dataset, hot_retention_days: days, action: 'archive_delete', status: 'active' }]])
    const source = (dataset: string) => config.sources.find(s => s.datasetId === dataset)!
    assert.match(String(resolveLearningDrainSource(source('dataset_snapshots'), active('dataset_snapshots', 45)).blockedReason), /gate_hot_window_mismatch/)
    assert.equal(resolveLearningDrainSource(source('strategy_decision_log'), active('strategy_decision_log', 45)).blockedReason,
      'm2_write_contract_and_long_lookback_readers_required')
    assert.equal(resolveLearningDrainSource(source('strategy_label_matrix_v4'), active('strategy_label_matrix_v4', 45)).blockedReason,
      'm2_write_contract_and_long_lookback_readers_required')
    assert.equal(resolveLearningDrainSource(source('s12_replay_trade_outcomes'), active('s12_replay_trade_outcomes', 120)).blockedReason,
      's12_python_readers_cold_merge_required')
    assert.equal(resolveLearningDrainSource(source('canonical_selection_labels_v4'), active('canonical_selection_labels_v4', 120)).blockedReason, 'no_drain_spec')
    const ok = resolveLearningDrainSource(source('dataset_snapshots'), active('dataset_snapshots', 120))
    assert.equal(ok.blockedReason, null)
    assert.equal(ok.source.deleteTable, 'dataset_snapshots')
    assert.equal(ok.hotRetentionDays, 120)
  } finally { f.sql.close() }
})

function snapshot(id: string, patch: Record<string, unknown> = {}) {
  return { snapshot_id: id, kind: 'strategy_learning_run_report', business_date: '2026-06-01', schema_version: 'r2-report-json-v1',
    row_count: 1, checksum: 'sha256:' + id, primary_store: 'r2', access_tier: 'report', r2_key: `reports/${id}.json`,
    producer_run_id: 'run-' + id, status: 'ready', metadata_json: '{"role":"r2_human_readable_report"}',
    created_at: '2026-06-01 10:00:00', updated_at: '2026-06-01 10:00:00', ...patch }
}

test('dataset_snapshots: only old run-report / D1 hot-window manifests drain; cold read restores them exactly', async () => {
  const f = fixture(['dataset_snapshots'])
  try {
    const old = 'strategy_learning_run_report:2026-06-01:run-a'
    insert(f.sql, 'dataset_snapshots', snapshot(old))
    insert(f.sql, 'dataset_snapshots', snapshot('price_hot_window:2026-06-02:q', { kind: 'price_hot_window', business_date: '2026-06-02',
      primary_store: 'd1', access_tier: 'serving', r2_key: null }))
    insert(f.sql, 'dataset_snapshots', snapshot('audit:2026-06-01:x', { kind: 'd1_audit_json_archive', access_tier: 'archive' }))
    insert(f.sql, 'dataset_snapshots', snapshot('backtest_dataset:2026-06-01:y', { kind: 'backtest_dataset', primary_store: 'gcs', access_tier: 'compute', r2_key: null }))
    insert(f.sql, 'dataset_snapshots', snapshot('d1_cold_archive:2026-06-01:z', { kind: 'd1_cold_archive', primary_store: 'gcs', access_tier: 'archive', r2_key: null }))
    insert(f.sql, 'dataset_snapshots', snapshot('pending_run_report:2026-06-01:p', { status: 'pending' }))
    insert(f.sql, 'dataset_snapshots', snapshot('strategy_learning_run_report:2026-10-01:new', { business_date: '2026-10-01' }))
    const before = f.hotRead('dataset_snapshots', 'business_date')

    // Draft gate: confirmed drain archives / deletes nothing for this dataset.
    const draft = await f.drain()
    assert.equal(draft.status, 'success')
    assert.ok(draft.blocked_datasets.includes('learning_lineage_v1:dataset_snapshots'))
    assert.equal(f.hotRead('dataset_snapshots', 'business_date').length, before.length)
    assert.equal(f.objects.size, 0)

    f.gate('dataset_snapshots', 120)
    const result = await f.drain()
    assert.equal(result.status, 'success')
    // policies[] holds the last round; the first round released both rows.
    const item = result.policies[0].datasets.find(d => d.dataset_id === 'dataset_snapshots')!
    assert.equal(item.cutoff_date, CUTOFF_120)
    assert.equal(result.deleted_rows, 2)
    const { after } = await assertParity(f, 'dataset_snapshots', 'business_date', before, 2)
    for (const kept of ['audit:2026-06-01:x', 'backtest_dataset:2026-06-01:y', 'd1_cold_archive:2026-06-01:z',
      'pending_run_report:2026-06-01:p', 'strategy_learning_run_report:2026-10-01:new'])
      assert.ok(after.some(r => r.snapshot_id === kept), kept)
    // Exact-key lookup used by the admin manifest route.
    const cold = await findArchivedLearningRow(f.env, f.db, 'dataset_snapshots', 'snapshot_id', old, { startDate: '2026-06-01', endDate: '2026-06-01' })
    const { __rowid, ...original } = before.find(r => r.snapshot_id === old)!
    assert.deepEqual({ ...cold }, { ...original })
    // Idempotent: a second confirmed pass finds nothing new and deletes nothing.
    const again = await f.drain()
    assert.equal(again.deleted_rows, 0)
    assert.equal(again.policies[0].datasets.find(d => d.dataset_id === 'dataset_snapshots')!.status, 'skipped')
    // A rewritten hot row with the same snapshot_id wins over the archive.
    insert(f.sql, 'dataset_snapshots', snapshot(old, { status: 'expired' }))
    assert.equal(await findArchivedLearningRow(f.env, f.db, 'dataset_snapshots', 'snapshot_id', old, { startDate: '2026-06-01', endDate: '2026-06-01' }), null)
  } finally { f.sql.close() }
})

test('dataset_snapshots admin routes: manifest / preview / list serve released rows cold; cold failure is 503, not 404', async () => {
  const f = fixture(['dataset_snapshots'])
  try {
    const old = 'strategy_learning_run_report:2026-06-01:run-a'
    insert(f.sql, 'dataset_snapshots', snapshot(old))
    insert(f.sql, 'dataset_snapshots', snapshot('audit:2026-06-01:x', { kind: 'd1_audit_json_archive', access_tier: 'archive' }))
    f.objects.set(`reports/${old}.json`, '{"report":"run-a"}')
    f.gate('dataset_snapshots', 120)
    assert.equal((await f.drain()).deleted_rows, 1)
    const env = { ...f.env, STOCKVISION_AUTH_TOKEN: 'svc' } as unknown as Bindings
    const get = async (path: string) => {
      const res = await adminReadRoutes.request(path, { headers: { Authorization: 'Bearer svc' } }, env)
      return { status: res.status, body: await res.json() as any }
    }
    const manifest = await get(`/api/admin/datasets/snapshots/${encodeURIComponent(old)}/manifest`)
    assert.equal(manifest.status, 200)
    assert.equal(manifest.body.cold_archive, true)
    assert.equal(manifest.body.manifest.snapshot_id, old)
    assert.deepEqual(manifest.body.manifest.manifest_errors, [])
    const preview = await get(`/api/datasets/snapshots/${encodeURIComponent(old)}/preview`)
    assert.equal(preview.status, 200)
    assert.equal(preview.body.cold_archive, true)
    assert.equal(preview.body.preview, '{"report":"run-a"}')
    const list = await get('/api/admin/datasets/snapshots?date=2026-06-01')
    assert.deepEqual(list.body.cold_archive, { included: true, rows: 1 })
    assert.deepEqual(list.body.snapshots.map((r: any) => [r.snapshot_id, r.cold_archive === true]).sort(),
      [['audit:2026-06-01:x', false], [old, true]])
    const kindList = await get('/api/admin/datasets/snapshots?date=2026-06-01&kind=d1_audit_json_archive')
    assert.deepEqual(kindList.body.snapshots.map((r: any) => r.snapshot_id), ['audit:2026-06-01:x'])
    const undated = await get('/api/admin/datasets/snapshots')
    assert.deepEqual(undated.body.cold_archive, { included: false, rows: 0, reason: 'date_filter_required' })
    assert.equal((await get('/api/admin/datasets/snapshots/x_run_report:2026-06-05:none/manifest')).status, 404)
    assert.equal((await get('/api/admin/datasets/snapshots/no-date-id/preview')).status, 404)
    // Corrupt archive: every endpoint answers 503 with the stable code and no checksum detail.
    const key = [...f.objects.keys()].find(k => !k.startsWith('reports/'))!
    f.objects.set(key, f.objects.get(key)!.replace('run-a', 'run-z'))
    for (const path of [`/api/admin/datasets/snapshots/${encodeURIComponent(old)}/manifest`,
      `/api/admin/datasets/snapshots/${encodeURIComponent(old)}/preview`, '/api/admin/datasets/snapshots?date=2026-06-01']) {
      const failed = await get(path)
      assert.equal(failed.status, 503, path)
      assert.deepEqual(failed.body, { success: false, error: DATASET_SNAPSHOT_COLD_READ_ERROR })
    }
    // Filters that can never match a drained manifest skip the archive read (hot rows still served).
    for (const query of ['kind=d1_audit_json_archive', 'access_tier=archive']) {
      const skipped = await get(`/api/admin/datasets/snapshots?date=2026-06-01&${query}`)
      assert.equal(skipped.status, 200, query)
      assert.deepEqual(skipped.body.cold_archive, { included: false, rows: 0, reason: 'filter_never_drains' })
      assert.deepEqual(skipped.body.snapshots.map((r: any) => r.snapshot_id), ['audit:2026-06-01:x'])
    }
  } finally { f.sql.close() }
})

function structure(id: number, source: string, patch: Record<string, unknown> = {}) {
  return { id, trade_date: '2026-06-03', symbol: String(2300 + id), source, state: 'ready', ready: 1, invalidated: 0,
    raw_json: JSON.stringify({ n: id, pad: 'x'.repeat(200) }), updated_at: '2026-06-03 09:00:00', created_at: '2026-06-03 09:00:00', ...patch }
}

test('s12_structure_snapshots (NEW-Q14 plan B): live paper sources never drain; Worker readers keep parity', async () => {
  const f = fixture(['s12_structure_snapshots'])
  try {
    insert(f.sql, 's12_structure_snapshots', structure(1, 's12_candidate_snapshot'))
    insert(f.sql, 's12_structure_snapshots', structure(2, 's12_research_structure_snapshot'))
    S12_STRUCTURE_LIVE_SOURCES.forEach((source, i) => insert(f.sql, 's12_structure_snapshots', structure(10 + i, source)))
    insert(f.sql, 's12_structure_snapshots', structure(20, 's12_candidate_snapshot', { trade_date: '2026-10-20' }))
    const before = f.hotRead('s12_structure_snapshots', 'trade_date')
    const evidenceBefore = await mergeArchivedS12Evidence(f.env, f.db, '2026-06-03', ['2301'],
      f.sql.prepare("SELECT symbol,source,state,ready,invalidated,updated_at,id FROM s12_structure_snapshots WHERE trade_date='2026-06-03' AND symbol='2301'").all() as any[])
    f.gate('s12_structure_snapshots', 120)
    const result = await f.drain()
    assert.equal(result.status, 'success')
    const { after } = await assertParity(f, 's12_structure_snapshots', 'trade_date', before, 2)
    assert.deepEqual(after.filter(r => (S12_STRUCTURE_LIVE_SOURCES as readonly string[]).includes(String(r.source))).length, S12_STRUCTURE_LIVE_SOURCES.length)
    // The existing production reader (strategy hydration) sees the same winner from cold storage.
    const evidenceAfter = await mergeArchivedS12Evidence(f.env, f.db, '2026-06-03', ['2301'], [])
    assert.deepEqual(evidenceAfter.map(r => ({ ...r })), evidenceBefore.map(r => ({ ...r })))
    assert.equal(evidenceAfter.length, 1)
  } finally { f.sql.close() }
})

function replayRow(id: number, patch: Record<string, unknown> = {}) {
  return { id, symbol: String(2300 + id), market: 'LISTED', signal_date: '2026-06-01', trade_date: '2026-06-02', setup_id: 'setup' + id,
    sample_eligible: 1, pnl_pct: (id % 7 - 2) * .012, source: 's12_multisession_structure_replay_v3', detail_json: JSON.stringify({
      schema_version: 's12-replay-trade-outcome-v3', observation_kind: 'executed',
      replay_diagnostics: { replay_engine_signature: ENGINE, outcome_known_date: '2026-06-10' } }), ...patch }
}

test('s12_replay_trade_outcomes: gated drain uses the compact release path; raw cold read keeps parity', async () => {
  const f = fixture([])
  try {
    f.sql.exec(tableDdl(learning, 's12_replay_trade_outcomes').replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE'))
    f.sql.exec(`CREATE TABLE allocator_ev_daily_lifecycle(business_date TEXT PRIMARY KEY,state TEXT,updated_at TEXT,upstream_run_id TEXT)`)
    for (const migration of ['0056_s12_replay_reward_covering_index.sql', '0057_s12_replay_cold_release.sql'])
      f.sql.exec(readFileSync('domain-migrations/learning/' + migration, 'utf8'))
    insert(f.sql, 's12_replay_trade_outcomes', replayRow(1))
    insert(f.sql, 's12_replay_trade_outcomes', replayRow(2))
    insert(f.sql, 's12_replay_trade_outcomes', replayRow(3, { trade_date: '2026-10-21', signal_date: '2026-10-20' }))
    const before = f.hotRead('s12_replay_trade_outcomes', 'trade_date')
    f.gate('s12_replay_trade_outcomes', 120)
    // Python readers (allocator EV fusion, optuna router) read only the hot table: code-blocked even when gated.
    const blockedRun = await f.drain()
    const blockedItem = blockedRun.policies[0].datasets.find(d => d.dataset_id === 's12_replay_trade_outcomes')!
    assert.equal(blockedItem.status, 'blocked')
    assert.match(String(blockedItem.error), /s12_python_readers_cold_merge_required/)
    assert.equal(f.hotRead('s12_replay_trade_outcomes', 'trade_date').length, before.length)
    // Future path (after Wei picks cold merge or reader retirement): lift the code block for this test only.
    const spec = LEARNING_DRAIN_SPECS.s12_replay_trade_outcomes
    const codeBlock = spec.codeBlockedReason
    delete spec.codeBlockedReason
    let result
    try { result = await f.drain() } finally { spec.codeBlockedReason = codeBlock }
    assert.equal(result.status, 'success', JSON.stringify(result.policies[0].datasets))
    await assertParity(f, 's12_replay_trade_outcomes', 'trade_date', before, 2)
    assert.equal(Number(f.sql.prepare('SELECT COUNT(*) n FROM s12_replay_cold_batches_v1').get()?.n), 1)
    // The existing Worker replay reader serves the same two released rows.
    const replay: any[] = []
    for await (const chunk of archivedS12ReplayChunks(f.env, f.db, '2026-01-01', '2026-11-05', '2099-01-01T00:00:00Z')) replay.push(...chunk)
    assert.deepEqual(replay.map(r => r.id).sort(), [1, 2])
  } finally { f.sql.close() }
})

function decision(n: number, date: string) {
  return { decision_id: `d-${date}-${n}`, date, symbol: String(2300 + n), strategy_id: 's1', strategy_version: 'v1', strategy_status: 'active',
    alpha_bucket: 'core', matched: n % 2, reason_code: 'ok', context_json: '{"ref":"r2://ctx"}', evidence_json: '{"ref":"r2://ev"}' }
}
function label(n: number, date: string) {
  return { signal_date: date, symbol: String(2300 + n), producer_run_id: 'run', strategy_id: 's1', strategy_version: 'v1',
    strategy_status: 'active', alpha_bucket: 'core', family_id: 'f', production_owner: 1, strategy_hit: n % 2, weak_label: .1 * n,
    affinity: .5, position_weight: .2, overlap: 0, labeler_version: 'l', strategy_registry_checksum: 'c', reference_contract_version: 'r' }
}

// strategy_decision_log / strategy_label_matrix_v4: the gate can be set to 45 days, but the drain stays
// code-blocked until the M2 write contract (and the long-lookback readers) are handled. The cold
// reader and exact release are proven now by releasing a chunk through the same primitives.
for (const [table, dateColumn, row] of [['strategy_decision_log', 'date', decision], ['strategy_label_matrix_v4', 'signal_date', label]] as const) {
  test(`${table}: 45-day gate stays blocked in the drain; release + cold read keep exact parity`, async () => {
    const f = fixture([table])
    try {
      for (let n = 1; n <= 3; n++) insert(f.sql, table, row(n, '2026-09-01'))
      insert(f.sql, table, row(9, '2026-10-30'))
      const before = f.hotRead(table, dateColumn)
      f.gate(table, 45)
      const result = await f.drain()
      const item = result.policies[0].datasets.find(d => d.dataset_id === table)!
      assert.equal(item.status, 'blocked')
      assert.match(String(item.error), /m2_write_contract_and_long_lookback_readers_required/)
      // The blocked item and the policy show this dataset's own 45-day window, not the policy's 120.
      assert.equal(item.cutoff_date, '2026-09-21')
      assert.equal(result.policies[0].dataset_cutoffs[table], '2026-09-21')
      assert.equal(result.policies[0].dataset_cutoffs.dataset_snapshots, CUTOFF_120)
      assert.equal(f.hotRead(table, dateColumn).length, before.length)

      // Simulate the future enabled drain chunk with the same exact-row primitives.
      const config = retentionR2PolicyConfig('learning_lineage_v1')!.sources.find(s => s.datasetId === table)!
      const source = { ...config, deleteTable: table, deleteKeyColumn: 'rowid', eligibilitySql: LEARNING_DRAIN_SPECS[table].eligibilitySql }
      const cutoff = '2026-09-21' // 2026-11-05 minus 45 days
      const columns = (f.sql.prepare('SELECT name FROM pragma_table_info(?)').all(table) as any[]).map(r => r.name)
      const rows = f.sql.prepare(buildBoundedRetentionSelect(source, columns)).all(cutoff, 250, 1024 * 1024) as Record<string, unknown>[]
      assert.equal(rows.length, 3)
      // A rowid move (ref-v2 style) between export and delete fails closed: nothing deleted.
      f.sql.exec(`UPDATE ${table} SET rowid=rowid+1000 WHERE rowid=(SELECT MIN(rowid) FROM ${table})`)
      const raw0 = JSON.stringify({ x: 1 })
      await assert.rejects(releaseArchivedRows(f.db, source, cutoff, rows, { artifact_id: 'stale', checksum: await sha256Text(raw0) }))
      assert.equal(f.hotRead(table, dateColumn).length, before.length)
      f.sql.exec(`UPDATE ${table} SET rowid=rowid-1000 WHERE rowid>1000`)

      const domain = `retention_learning_lineage_v1_${table}`, schema = 'd1-retention-hot-window-drain-v1'
      const raw = JSON.stringify({ schema_version: schema, domain, business_date: BUSINESS_DATE, payload: { schema_version: schema,
        policy_id: 'learning_lineage_v1', dataset_id: table, source_domain: 'learning', cutoff_date: cutoff, hot_retention_days: 45, rows } })
      const artifact = { artifact_id: 'a-' + table, checksum: await sha256Text(raw) }
      f.objects.set('k-' + table, raw)
      f.sql.prepare(`INSERT INTO run_artifacts(artifact_id,retention_class,status,domain,business_date,producer_run_id,r2_key,checksum,
        schema_version,row_count,byte_size,created_at,retain_until,metadata_json,checksum_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(artifact.artifact_id, 'ten_year_cold_archive', 'ready', domain, BUSINESS_DATE, 'p', 'k-' + table, artifact.checksum, schema,
          rows.length, Buffer.byteLength(raw), '2026-11-05T00:00:00Z', '2036-11-02', JSON.stringify({ coverage_start: '2026-09-01', coverage_end: '2026-09-01' }), '2026-11-05T00:00:00Z')
      assert.equal(await releaseArchivedRows(f.db, source, cutoff, rows, artifact), 3)
      await assertParity(f, table, dateColumn, before, 3)
    } finally { f.sql.close() }
  })
}

test('cold reader fails closed: corrupt archive, missing release proof, read budget', async () => {
  const f = fixture(['dataset_snapshots'])
  try {
    insert(f.sql, 'dataset_snapshots', snapshot('strategy_learning_run_report:2026-06-01:run-a'))
    insert(f.sql, 'dataset_snapshots', snapshot('strategy_learning_run_report:2026-06-02:run-b', { business_date: '2026-06-02' }))
    f.gate('dataset_snapshots', 120)
    assert.equal((await f.drain()).deleted_rows, 2)
    const read = async (budget?: { bytes: number; manifests: number; rows: number }) => {
      const out: unknown[] = []
      for await (const chunk of archivedLearningRows(f.env, f.db, 'dataset_snapshots', { startDate: '2026-01-01', endDate: '2026-12-31', budget })) out.push(...chunk)
      return out
    }
    assert.equal((await read()).length, 2)
    await assert.rejects(read({ bytes: 1, manifests: 10, rows: 10 }), /read_budget_exceeded/)
    await assert.rejects(read({ bytes: 1e9, manifests: 10, rows: 1 }), /read_budget_exceeded/)
    // An exported-but-unreleased chunk (no source receipt, no OPS receipt) is not history.
    const domain = 'retention_learning_lineage_v1_dataset_snapshots', schema = 'd1-retention-hot-window-drain-v1'
    const ghost = { ...snapshot('strategy_learning_run_report:2026-06-03:ghost', { business_date: '2026-06-03' }), __cursor_key: 999, __archive_date: '2026-06-03' }
    const raw = JSON.stringify({ schema_version: schema, domain, business_date: BUSINESS_DATE, payload: { schema_version: schema,
      policy_id: 'learning_lineage_v1', dataset_id: 'dataset_snapshots', source_domain: 'learning', cutoff_date: CUTOFF_120, rows: [ghost] } })
    f.objects.set('ghost', raw)
    f.sql.prepare(`INSERT INTO run_artifacts(artifact_id,retention_class,status,domain,business_date,producer_run_id,r2_key,checksum,
      schema_version,row_count,byte_size,created_at,retain_until,metadata_json,checksum_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('zz-ghost', 'ten_year_cold_archive', 'ready', domain, BUSINESS_DATE, 'p', 'ghost', await sha256Text(raw), schema, 1,
        Buffer.byteLength(raw), '2026-11-05T00:00:00Z', '2036-11-02', '{}', '2026-11-05T00:00:00Z')
    await assert.rejects(read(), /release_receipt_incomplete/)
    // A manifest whose checksum was never verified is not served (same rule as the retention read route).
    f.sql.exec("UPDATE run_artifacts SET checksum_verified_at=NULL WHERE artifact_id='zz-ghost'")
    assert.equal((await read()).length, 2)
    f.sql.exec("DELETE FROM run_artifacts WHERE artifact_id='zz-ghost'")
    const key = [...f.objects.keys()][0]
    f.objects.set(key, f.objects.get(key)!.replace('run-a', 'run-z'))
    await assert.rejects(read(), /checksum_mismatch|size_invalid/)
  } finally { f.sql.close() }
})

function migratedSchema(domain: 'ops' | 'learning'): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(`domain-migrations/${domain}`).filter(name => name.endsWith('.sql')).sort())
    db.exec(readFileSync(`domain-migrations/${domain}/${file}`, 'utf8'))
  return db
}

test('D1 read cost: every statement of the gated drain and the cold reader is an index SEARCH on the migrated schema', async () => {
  const f = fixture(['dataset_snapshots', 's12_structure_snapshots'])
  const schemas = [migratedSchema('learning'), migratedSchema('ops')]
  try {
    insert(f.sql, 'dataset_snapshots', snapshot('strategy_learning_run_report:2026-06-01:a'))
    insert(f.sql, 'dataset_snapshots', snapshot('compute:2026-06-01:b', { kind: 'backtest_compute', access_tier: 'compute', primary_store: 'gcs' }))
    insert(f.sql, 's12_structure_snapshots', structure(1, 's12_research_structure_snapshot'))
    insert(f.sql, 's12_structure_snapshots', structure(2, 's12_holding_defense'))
    f.gate('dataset_snapshots', 120)
    f.gate('s12_structure_snapshots', 120)
    const result = await f.drain()
    assert.equal(result.status, 'success')
    assert.equal(result.deleted_rows, 2)
    for (const dataset of ['dataset_snapshots', 's12_structure_snapshots']) {
      let rows = 0
      for await (const chunk of archivedLearningRows(f.env, f.db, dataset, { startDate: '2026-01-01', endDate: '2026-12-31' })) rows += chunk.length
      assert.equal(rows, 1, dataset)
    }
    // Large tables only; json_each bindings, CTEs, pragma and sqlite_master probes are bounded by construction.
    const bounded = /^SCAN (json_each|j\b|expected|matched|candidates|budgeted|archive_rows|\(subquery|pragma_table_info|sqlite_master|CONSTANT ROW)/
    let checked = 0, candidatePlans = 0, probePlans = 0
    for (const query of f.queries) {
      let plan: Record<string, unknown>[] | null = null
      for (const schema of schemas) {
        try { plan = schema.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Record<string, unknown>[]; break } catch { /* other domain */ }
      }
      assert.ok(plan, `no migrated domain schema prepares: ${query.slice(0, 160)}`)
      const scans = plan.map(row => String(row.detail)).filter(detail => /^SCAN /.test(detail) && !bounded.test(detail))
      assert.deepEqual(scans, [], query.replace(/\s+/g, ' ').slice(0, 300))
      // Drain candidates walk the 0068 partial index in date order: no sort of the whole backlog, and
      // rows that stay hot forever (live s12 sources, non-drainable manifests) are never read.
      const table = /WITH candidates AS MATERIALIZED[\s\S]*?FROM "?(dataset_snapshots|s12_structure_snapshots)"? WHERE/.exec(query)?.[1]
      if (table) {
        const materialize = plan.find(row => String(row.detail) === 'MATERIALIZE candidates')!
        const inCandidates = plan.filter(row => row.parent === materialize.id).map(row => String(row.detail))
        const search = `SEARCH ${table} USING INDEX idx_${table}_m3_drainable (${LEARNING_DRAIN_SPECS[table].dateColumn}<?)`
        // s12 sorts only within one trade date (index is (trade_date, source)); never the whole backlog.
        assert.deepEqual(inCandidates, table === 's12_structure_snapshots'
          ? [search, 'USE TEMP B-TREE FOR LAST TERM OF ORDER BY'] : [search], table)
        candidatePlans += 1
      }
      // The first-page "anything left?" probe also stays on drainable rows (steady state: nothing to drain).
      const probe = /^SELECT 1 FROM (dataset_snapshots|s12_structure_snapshots) WHERE [\s\S]*<\? +LIMIT 1$/.exec(query.trim())?.[1]
      if (probe) {
        assert.ok(plan.every(row => String(row.detail).includes(`idx_${probe}_m3_drainable`)), JSON.stringify(plan))
        probePlans += 1
      }
      checked += 1
    }
    assert.equal(candidatePlans, 2)
    assert.equal(probePlans, 2)
    assert.ok(checked >= 20, `checked ${checked} statements`)
  } finally {
    f.sql.close()
    for (const schema of schemas) schema.close()
  }
})

test('learning migration 0068: each partial index WHERE is exactly the drain eligibility of its dataset', () => {
  const migration = readFileSync('domain-migrations/learning/0068_learning_m3_drain_partial_indexes.sql', 'utf8')
    .replace(/^--.*$/gm, '')
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
  for (const dataset of ['dataset_snapshots', 's12_structure_snapshots']) {
    const spec = LEARNING_DRAIN_SPECS[dataset]
    const match = new RegExp(`CREATE INDEX IF NOT EXISTS idx_${dataset}_m3_drainable\\s+ON ${dataset}\\(${spec.dateColumn}[^)]*\\)\\s+WHERE ([\\s\\S]*?);`).exec(migration)
    assert.ok(match, dataset)
    assert.equal(flat(match[1]), flat(spec.eligibilitySql.replaceAll(`${dataset}.`, '')), dataset)
  }
  // NEW-Q14 plan B: the s12 index (and therefore the drain) excludes exactly the live paper sources.
  assert.deepEqual([...S12_STRUCTURE_LIVE_SOURCES], ['s12_intraday_structure', 's12_holding_defense', 's12_intraday_structure_v1'])
})

test('drain: only an active archive_delete gate with the spec window releases rows; predictions drain as before', async () => {
  const f = fixture(['dataset_snapshots'])
  try {
    insert(f.sql, 'dataset_snapshots', snapshot('strategy_learning_run_report:2026-06-01:a'))
    insert(f.sql, 'predictions', { id: 7, stock_id: 2330, model_name: 'ensemble', prediction_date: '2026-06-01',
      generated_at: '2026-06-01 10:00:00', created_at: '2026-06-01 10:00:00' })
    const snapshots = () => f.hotRead('dataset_snapshots', 'business_date').length
    const reason = (result: Awaited<ReturnType<typeof f.drain>>) =>
      String(result.policies[0].datasets.find(d => d.dataset_id === 'dataset_snapshots')!.error)
    for (const [days, action, status, expected] of [
      [120, 'archive_only', 'active', /gate_active_archive_only/],
      [120, 'archive_delete', 'retired', /gate_retired_archive_delete/],
      [45, 'archive_delete', 'active', /gate_hot_window_mismatch_45_vs_120/],
    ] as const) {
      f.gate('dataset_snapshots', days, action, status)
      const result = await f.drain()
      assert.equal(result.status, 'success')
      assert.match(reason(result), expected)
      assert.equal(snapshots(), 1)
    }
    // Every gate blocked: predictions (no spec, M1-d tableSource) still drained, exactly as on main.
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM predictions').get()?.n, 0)
    let predictions = 0
    for await (const chunk of archivedLearningRows(f.env, f.db, 'predictions', { startDate: '2026-01-01', endDate: '2026-12-31' })) predictions += chunk.length
    assert.equal(predictions, 1)

    // A failed gate read keeps the gated dataset blocked without failing the policy.
    f.gate('dataset_snapshots', 120)
    const prepare = (f.db as any).prepare
    ;(f.db as any).prepare = (query: string) => {
      if (query.includes('FROM data_retention_dataset_gates')) throw new Error('D1_ERROR: overloaded')
      return prepare(query)
    }
    try {
      const result = await f.drain()
      assert.equal(result.status, 'success')
      assert.match(reason(result), /gate_read_failed/)
      assert.equal(snapshots(), 1)
    } finally { (f.db as any).prepare = prepare }
    assert.equal((await f.drain()).deleted_rows, 1)
    assert.equal(snapshots(), 0)
  } finally { f.sql.close() }
})

test('gates: a dataset with an M3 spec stays gated even if its archive source gains a delete table or eligibility', () => {
  const config = retentionR2PolicyConfig('learning_lineage_v1')!
  const source = (dataset: string) => config.sources.find(s => s.datasetId === dataset)!
  const active = (dataset: string, days: number) => new Map([[dataset, { dataset_id: dataset, hot_retention_days: days, action: 'archive_delete', status: 'active' }]])
  const deletable = (dataset: string) => ({ ...source(dataset), deleteTable: dataset, deleteKeyColumn: 'rowid' })
  assert.equal(resolveLearningDrainSource(deletable('strategy_decision_log'), new Map()).blockedReason, 'gate_missing')
  assert.equal(resolveLearningDrainSource(deletable('strategy_decision_log'), active('strategy_decision_log', 45)).blockedReason,
    'm2_write_contract_and_long_lookback_readers_required')
  assert.equal(resolveLearningDrainSource(deletable('s12_replay_trade_outcomes'), active('s12_replay_trade_outcomes', 120)).blockedReason,
    's12_python_readers_cold_merge_required')
  // The live-source exclusion is never bypassed: a source-level eligibility is a shape change, not a merge.
  const structure = resolveLearningDrainSource(deletable('s12_structure_snapshots'), active('s12_structure_snapshots', 120))
  assert.equal(structure.blockedReason, null)
  assert.match(structure.source.eligibilitySql, /NOT IN \('s12_intraday_structure','s12_holding_defense','s12_intraday_structure_v1'\)/)
  assert.equal(resolveLearningDrainSource({ ...source('s12_structure_snapshots'), eligibilitySql: "source<>'x'" },
    active('s12_structure_snapshots', 120)).blockedReason, 'archive_source_shape_changed')
  // predictions has no spec and keeps its own M1-d table source.
  assert.equal(resolveLearningDrainSource(source('predictions'), new Map()).blockedReason, null)
})

test('cold reader: an exported-but-unreleased chunk is ignored only when a released chunk serves the same rows', async () => {
  const f = fixture(['dataset_snapshots'])
  try {
    insert(f.sql, 'dataset_snapshots', snapshot('strategy_learning_run_report:2026-06-01:a'))
    insert(f.sql, 'dataset_snapshots', snapshot('strategy_learning_run_report:2026-06-02:b', { business_date: '2026-06-02' }))
    f.gate('dataset_snapshots', 120)
    assert.equal((await f.drain()).deleted_rows, 2)
    const released = JSON.parse([...f.objects.values()][0]).payload.rows as Record<string, unknown>[]
    const domain = 'retention_learning_lineage_v1_dataset_snapshots', schema = 'd1-retention-hot-window-drain-v1'
    // An earlier drain exported the same rows under another cutoff, then stopped before its DELETE batch.
    const orphan = async (id: string, rows: Record<string, unknown>[]) => {
      const raw = JSON.stringify({ schema_version: schema, domain, business_date: '2026-11-04', payload: { schema_version: schema,
        policy_id: 'learning_lineage_v1', dataset_id: 'dataset_snapshots', source_domain: 'learning', cutoff_date: '2026-07-07', rows } })
      f.objects.set(id, raw)
      f.sql.prepare(`INSERT INTO run_artifacts(artifact_id,retention_class,status,domain,business_date,producer_run_id,r2_key,checksum,
        schema_version,row_count,byte_size,created_at,retain_until,metadata_json,checksum_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 'ten_year_cold_archive', 'ready', domain, '2026-11-04', 'p', id, await sha256Text(raw), schema, rows.length,
          Buffer.byteLength(raw), '2026-11-04T00:00:00Z', '2036-11-01', '{}', '2026-11-04T00:00:00Z')
    }
    const read = async () => {
      const out: string[] = []
      for await (const chunk of archivedLearningRows(f.env, f.db, 'dataset_snapshots', { startDate: '2026-01-01', endDate: '2026-12-31' }))
        out.push(...chunk.map(item => String(item.row.snapshot_id)))
      return out.sort()
    }
    await orphan('00-orphan', released)  // sorts before the released artifact
    await orphan('zz-orphan', released)  // and after it
    assert.deepEqual(await read(), ['strategy_learning_run_report:2026-06-01:a', 'strategy_learning_run_report:2026-06-02:b'])
    // A row that only an unreleased export holds is lost history: fail closed, never a shorter answer.
    await orphan('zz-lost', [{ ...released[0], snapshot_id: 'strategy_learning_run_report:2026-06-01:lost', __cursor_key: 99 }])
    await assert.rejects(read(), /release_receipt_incomplete/)
  } finally { f.sql.close() }
})
