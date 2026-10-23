import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
  AUDIT_JSON_ARCHIVE_TARGET_IDS,
  AUDIT_JSON_DEFAULT_TARGET_IDS,
  AUDIT_JSON_REF_V2_GATE_KEY,
  AUDIT_JSON_REF_V2_SCHEMA,
  AUDIT_JSON_REF_V2_TARGET_ID,
  buildAuditJsonRetentionPlan,
  runAuditJsonArchiveRetention,
  summarizeAuditJsonArchiveRun,
} from './auditJsonArchive'
import { isMaintenanceLeaseBusy } from './maintenanceLease'
import { maintenanceLeaseYieldRequested, runWithMaintenanceLeaseYielding } from './maintenanceLeaseYield'
import { auditHistoricalSelectionEvidenceRecoveryPreflight } from './historicalSelectionEvidenceRecoveryPreflight'
import { sha256Text } from './datasetSnapshots'
import { enqueueMaintenanceBacklogDrain, processMaintenanceBacklogDrain } from './maintenanceBacklogDrain'
import { admitSchedulerExecutionTicket } from './schedulerExecutionTickets'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'
import type { UpdateQueueMsg } from '../types'

const learningSchema = readFileSync(new URL('../../domain-schemas/learning.sql', import.meta.url), 'utf8')
const opsSchema = readFileSync(new URL('../../domain-schemas/ops.sql', import.meta.url), 'utf8')
const paperSchema = readFileSync(new URL('../../domain-schemas/paper.sql', import.meta.url), 'utf8')
const BUSINESS_DATE = '2026-10-23'
const HOT_CUTOFF = '2026-10-16'
const REF = AUDIT_JSON_REF_V2_TARGET_ID
const REF_CONTEXT = JSON.stringify({ schema_version: AUDIT_JSON_REF_V2_SCHEMA })

function ddl(name: string): string {
  const match = [learningSchema, opsSchema, paperSchema].join('\n')
    .match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))
  assert(match, `production domain schema missing: ${name}`)
  return match[0]
}
const DECISION_INDEXES = learningSchema.match(/CREATE (?:UNIQUE )?INDEX[^;]*ON strategy_decision_log\b[^;]*;/g) ?? []

type Family = 'A' | 'B' | 'C' | 'D' | 'L'
const pit = (date: string) => ({ schema_version: 'strategy-decision-pit-reconstruction-v5', no_lookahead: true, knowledge_cutoff: date })
const hotEvidence = (date: string) => ({
  pit_reconstruction: pit(date),
  feature_ref_diagnostics: { refs: [null, false, 0], pass: true },
  evaluability: { status: 'EVALUABLE' },
  signal_dsl_diagnostics: [{ pass: false }],
  base_gate_diagnostics: null,
  rejection_diagnostics: ['保留原因'],
})
const hotContext = { candidate: { raw_signals: { technical: 0.4, valid: false }, industry: '半導體', current_price: 100 }, score_v2: { score: 87 } }

// Production-shaped JSON per family (findings P0-9): A = audit pointer, B = strategy
// pointer (ids NOT NULL), C/D = matrix projection stubs (ids NULL), L = legacy full JSON.
function familyRow(family: Family, id: string, date: string, symbol = id) {
  const checksum = `sha256:${'a'.repeat(64)}`
  if (family === 'A') {
    const pointer = (column: string) => JSON.stringify({
      schema_version: 'd1-audit-json-pointer-v1', archived_to_r2: true, archive_kind: 'd1_audit_json_archive',
      table: 'strategy_decision_log', key_column: 'decision_id', key_value: id, blob_column: column,
      snapshot_id: `d1_audit_json_archive:strategy_decision_log:${date}:audit-json-retention-run:${id}-${id}:${checksum}`,
      r2_key: `archives/d1_audit_json_archive/target=strategy_decision_log/business_date=${date}/run_id=audit-json-retention-run/cutoff_date=${date}/chunk=${id}-${checksum}.json`,
      checksum, archived_at: '2026-09-13T17:00:07.826Z', original_byte_length: 1901,
    })
    return { decision_id: id, date, symbol, context_json: pointer('context_json'), evidence_json: pointer('evidence_json'), context_id: `ctx-${id}`, evidence_artifact_id: `art-${id}` }
  }
  if (family === 'B') {
    const contextId = `strategy-context:${date}:${symbol}:ccd71d2`
    const artifact = { artifact_id: `artifact:strategy_decision_evidence:${date}:${id}`, r2_key: `evidence/class=canonical_model_evidence/date=${date}/${id}.json`, checksum }
    return {
      decision_id: id, date, symbol,
      context_json: JSON.stringify({ schema_version: 'strategy-context-pointer-v1', context_id: contextId, ...artifact }),
      evidence_json: JSON.stringify({ schema_version: 'strategy-evidence-pointer-v1', ...artifact, ...hotEvidence(date) }),
      context_id: contextId, evidence_artifact_id: artifact.artifact_id,
    }
  }
  if (family === 'L') {
    return {
      decision_id: id, date, symbol,
      context_json: JSON.stringify({ ...hotContext, market: '冷資料'.repeat(200) }),
      evidence_json: JSON.stringify({ ...hotEvidence(date), full_decision: '完整證據'.repeat(200) }),
      context_id: null, evidence_artifact_id: null,
    }
  }
  const kind = family === 'C' ? 'canonical-matrix-repair-v2' : 'historical-matrix-projection-v1'
  const run = { producer_run_id: 'screener-v2-1790863956-7ce6dd40', reference_contract_version: 'selection-reference-snapshot-v4-regime-veto-v1' }
  return {
    decision_id: id, date, symbol,
    context_json: JSON.stringify({ schema_version: `strategy-context-${kind}`, signal_date: date, symbol, ...run }),
    evidence_json: JSON.stringify({
      schema_version: `strategy-decision-${kind}`, source: 'canonical_strategy_label_matrix_v4', ...run,
      labeler_version: 'strategy-labeler-v3-regime-veto-counterfactual', strategy_registry_checksum: checksum, no_lookahead: true,
    }),
    context_id: null, evidence_artifact_id: null,
  }
}

function fixture(gate: 'manual' | 'scheduled' | null = 'manual') {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  for (const name of ['strategy_decision_log', 'strategy_candidate_contexts', 'dataset_snapshots',
    'canonical_selection_labels_v4', 'canonical_selection_label_rejections_v4',
    'selection_reference_snapshots_v1', 'strategy_label_matrix_v4', 'strategy_label_matrix_runs_v4',
    'data_retention_runs', 'data_retention_run_items', 'data_retention_cursors']) db.exec(ddl(name))
  for (const index of DECISION_INDEXES) db.exec(index)
  const pragma = (name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0])
  const usedBytes = () => (pragma('page_count') - pragma('freelist_count')) * pragma('page_size')
  const stats = { puts: 0, scrubBatches: [] as number[] }
  const adapter = { prepare(sql: string) {
    let params: any[] = []
    return {
      sql, bind(...values: any[]) { params = values; return this },
      async all() { return { results: db.prepare(sql).all(...params), meta: { size_after: usedBytes() } } },
      async first() { return db.prepare(sql).get(...params) ?? null },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } } },
    }
  }, async batch(statements: Array<{ sql: string; run(): Promise<unknown> }>) {
    if (statements.some(statement => statement.sql.includes('WITH backed_up'))) stats.scrubBatches.push(statements.length)
    db.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      db.exec('COMMIT')
      return results
    } catch (error) { db.exec('ROLLBACK'); throw error }
  } }
  const kv = new Map<string, string>()
  const setGate = (mode: string | null) => mode == null ? kv.delete(AUDIT_JSON_REF_V2_GATE_KEY)
    : kv.set(AUDIT_JSON_REF_V2_GATE_KEY, JSON.stringify({ mode, approved_by: 'wei', approved_at: '2026-10-23T00:00:00Z' }))
  setGate(gate)
  const objects = new Map<string, string>()
  const state = { onPut: null as (() => void) | null }
  const env = {
    DB: adapter,
    KV: { async get(key: string, type?: string) { const v = kv.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v } },
    ARTIFACTS: {
      async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body } },
      async put(key: string, body: string, options: any) {
        assert.equal(options.onlyIf.etagDoesNotMatch, '*')
        assert.equal(options.customMetadata.checksum, await sha256Text(body))
        objects.set(key, body); stats.puts++; state.onPut?.()
      },
    },
  } as any
  function insert(row: Record<string, unknown>) {
    db.prepare(`INSERT INTO strategy_decision_log(decision_id,date,symbol,strategy_id,strategy_version,strategy_status,
      alpha_bucket,matched,match_score,reason_code,context_json,evidence_json,context_id,evidence_artifact_id,
      evaluable,evaluability_status,evaluation_contract_version)
      VALUES(?,?,?,'S1','v1','challenger','trend',1,0.625,'matched',?,?,?,?,1,'EVALUABLE','strategy-evaluation-v2')`)
      .run(String(row.decision_id), String(row.date), String(row.symbol), String(row.context_json), String(row.evidence_json),
        (row.context_id ?? null) as string | null, (row.evidence_artifact_id ?? null) as string | null)
  }
  let sequence = 0
  const run = (options: Record<string, unknown> = {}) => runAuditJsonArchiveRetention(env, {
    businessDate: BUSINESS_DATE, runId: `ref-v2-${++sequence}`, targets: [REF],
    dryRun: false, confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE, limitPerTable: 1000, ...options,
  })
  const read = (id: string) => db.prepare('SELECT rowid AS __rowid, * FROM strategy_decision_log WHERE decision_id=?').get(id)! as Record<string, any>
  const maxRowid = () => Number(db.prepare('SELECT MAX(rowid) m FROM strategy_decision_log').get()!.m)
  const ledgerRows = () => Number(db.prepare('SELECT COUNT(*) n FROM data_retention_runs').get()!.n)
  return { db, env, stats, objects, state, setGate, insert, run, read, maxRowid, ledgerRows, pragma, usedBytes }
}

const nonJsonColumns = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !['__rowid', 'context_json', 'evidence_json'].includes(key)))

test('four production families, including NULL-id rows, round-trip through R2 and move to fresh rowids', async () => {
  const f = fixture()
  try {
    const rows = [
      familyRow('A', 'a-0814', '2026-08-14'), familyRow('B', 'b-0615', '2026-06-15'),
      familyRow('C', 'c-0901', '2026-09-01'), familyRow('D', 'd-1001', '2026-10-01'),
      familyRow('L', 'l-0520', '2026-05-20'),
    ]
    for (const row of rows) f.insert(row)
    f.insert(familyRow('D', 'hot-1020', '2026-10-20'))
    const before = new Map(rows.map(row => [row.decision_id, { ...f.read(row.decision_id) }]))
    const hotBefore = { ...f.read('hot-1020') }
    const oldMax = f.maxRowid()

    const result = await f.run()
    const table = result.tables[0]
    assert.equal(table.status, 'archived')
    assert.equal(table.cutoff_date, HOT_CUTOFF)
    assert.equal(table.scrubbed_rows, rows.length)
    assert.equal(f.stats.puts, 1)

    const [body] = [...f.objects.values()]
    assert.equal(await sha256Text(body), table.checksum)
    const payload = JSON.parse(body)
    assert.equal(payload.hot_days, 7)
    assert.equal(payload.rowid_moved, true)
    for (const archived of payload.rows) {
      const original = before.get(archived.decision_id)!
      for (const [column, value] of Object.entries(original)) assert.equal(archived[column], value, `${archived.decision_id}.${column}`)
    }

    const digest = String(table.checksum).replace(/^sha256:/, '').slice(0, 24)
    const ordered = [...before.values()].sort((a, b) => `${a.date}|${a.decision_id}`.localeCompare(`${b.date}|${b.decision_id}`))
    ordered.forEach((original, index) => {
      const after = f.read(String(original.decision_id))
      assert.deepEqual(nonJsonColumns(after), nonJsonColumns(original))
      assert.equal(after.__rowid, oldMax + 1 + index, 'rowids continue after the old MAX in (date, decision_id) order')
      const context = JSON.parse(after.context_json)
      const evidence = JSON.parse(after.evidence_json)
      assert.equal(context.schema_version, AUDIT_JSON_REF_V2_SCHEMA)
      assert.equal(evidence.schema_version, AUDIT_JSON_REF_V2_SCHEMA)
      assert.equal(evidence.archive, digest)
      const originalContext = JSON.parse(original.context_json)
      const originalEvidence = JSON.parse(original.evidence_json)
      for (const key of ['candidate', 'score_v2']) assert.deepEqual(context[key], originalContext[key])
      for (const key of Object.keys(hotEvidence('x'))) assert.deepEqual(evidence[key], originalEvidence[key])
      assert(Buffer.byteLength(after.context_json) + Buffer.byteLength(after.evidence_json)
        < Buffer.byteLength(original.context_json) + Buffer.byteLength(original.evidence_json))
    })
    for (const id of ['a-0814', 'c-0901', 'd-1001']) {
      assert.equal(f.read(id).context_json, REF_CONTEXT)
      assert.equal(f.read(id).evidence_json, JSON.stringify({ schema_version: AUDIT_JSON_REF_V2_SCHEMA, archive: digest }))
    }
    assert.deepEqual({ ...f.read('hot-1020') }, hotBefore, 'rows inside the 7-day hot window are untouched')

    // Forensic chain: archive digest -> manifest -> R2 pre-image.
    const manifest = f.db.prepare('SELECT r2_key, metadata_json FROM dataset_snapshots WHERE checksum LIKE ?').get(`sha256:${digest}%`)!
    assert.equal(f.objects.get(String(manifest.r2_key)), body)
    const metadata = JSON.parse(String(manifest.metadata_json))
    assert.equal(metadata.retention_action, 'compact_json_columns_to_ref_v2_and_move_rowid')
    assert.equal(metadata.rowid_moved, true)
  } finally { f.db.close() }
})

test('real readers see identical retained fields: recovery preflight, V5 context SQL and V5 json_patch', async () => {
  const f = fixture()
  try {
    const date = '2026-08-14'
    const b = familyRow('B', 'b-2330', date, '2330')
    const l = familyRow('L', 'l-2317', date, '2317')
    const d = familyRow('D', 'd-1101', date, '1101')
    for (const row of [b, l, d]) f.insert(row)
    f.db.prepare(`INSERT INTO strategy_candidate_contexts(context_id,date,symbol,context_hash,artifact_id,r2_key,checksum,raw_signals_json,current_price,industry)
      VALUES(?,?,?,'h','artifact','evidence/key','sha256:x',?,612,'半導體')`).run(String(b.context_id), date, '2330', JSON.stringify({ technical: 0.9, score_v2: { score: 70 } }))
    for (const symbol of ['2330', '2317', '1101']) {
      f.db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,hard_gate_passed,hard_gate_reason,
        feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_registry_checksum,feature_contract_version)
        VALUES(?,?,'producer',1,'ok',1,1,1,'l1','sha256:r','v')`).run(date, symbol)
    }
    // Same SQL as strategyLearning.ts V5 rebuild; the contract below fails if the source drifts.
    const v5ContextSql = `SELECT d.symbol, d.context_json, c.raw_signals_json AS context_raw_signals_json, c.current_price AS context_current_price, c.industry AS context_industry FROM strategy_decision_log d LEFT JOIN strategy_candidate_contexts c ON c.context_id=d.context_id WHERE d.date=? AND EXISTS ( SELECT 1 FROM selection_reference_snapshots_v1 r WHERE r.signal_date=d.date AND r.symbol=d.symbol AND r.producer_run_id=? AND r.hard_gate_passed=1 ) GROUP BY d.symbol`
    const learningSource = readFileSync(new URL('./strategyLearning.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ')
    assert(learningSource.includes(v5ContextSql), 'V5 context SQL drifted: re-audit ref-v2 retained fields')
    const v5Inputs = () => (f.db.prepare(v5ContextSql).all(date, 'producer') as any[]).map((row) => {
      const full = JSON.parse(row.context_json || '{}')
      const raw = JSON.parse(row.context_raw_signals_json || '{}')
      return {
        symbol: row.symbol,
        industry: row.context_industry ?? full?.candidate?.industry ?? null,
        current_price: row.context_current_price ?? full?.candidate?.current_price ?? null,
        raw_signals: Object.keys(raw).length ? raw : full?.candidate?.raw_signals ?? null,
        score_v2: raw.score_v2 ?? full?.score_v2 ?? null,
      }
    })
    const preflight = () => auditHistoricalSelectionEvidenceRecoveryPreflight(f.env.DB, {
      signalDate: date, producerRunId: 'producer', asOfDate: BUSINESS_DATE, artifactEvidence: null,
    })
    const inputsBefore = v5Inputs()
    const preflightBefore = await preflight()
    assert(preflightBefore.pitPacketRows >= 1)
    assert.equal((await f.run()).tables[0].scrubbed_rows, 3)
    assert.deepEqual(v5Inputs(), inputsBefore)
    assert.deepEqual(await preflight(), preflightBefore)

    const patch = { pit_reconstruction: pit('2026-08-15'), evaluation_contract_version: 'strategy-evaluation-v5' }
    f.db.prepare('UPDATE strategy_decision_log SET evidence_json=json_patch(evidence_json, ?) WHERE decision_id=?').run(JSON.stringify(patch), 'd-1101')
    const patched = JSON.parse(String(f.read('d-1101').evidence_json))
    assert.deepEqual(patched.pit_reconstruction, patch.pit_reconstruction)
    assert.equal(patched.schema_version, AUDIT_JSON_REF_V2_SCHEMA)
  } finally { f.db.close() }
})

test('idempotent: a second pass finds nothing and the legacy target never wraps ref-v2', async () => {
  const f = fixture()
  try {
    for (const family of ['A', 'B', 'C', 'D'] as const) f.insert(familyRow(family, `${family}-0801`, '2026-08-01'))
    assert.equal((await f.run()).total_scrubbed_rows, 4)
    const after = ['A', 'B', 'C', 'D'].map(family => ({ ...f.read(`${family}-0801`) }))
    const puts = f.stats.puts
    const second = await f.run()
    assert.equal(second.tables[0].candidate_rows, 0)
    assert.equal(second.tables[0].backlog_remaining, false)
    const legacy = await f.run({ targets: ['strategy_decision_log'], retentionDays: 30, minBlobBytes: 1 })
    assert.equal(legacy.total_scrubbed_rows, 0)
    assert.equal(f.stats.puts, puts)
    assert.deepEqual(['A', 'B', 'C', 'D'].map(family => ({ ...f.read(`${family}-0801`) })), after)
  } finally { f.db.close() }
})

test('a concurrent rewrite between archive and CAS leaves that row untouched', async () => {
  const f = fixture()
  try {
    f.insert(familyRow('D', 'd-1', '2026-09-01'))
    f.insert(familyRow('B', 'b-2', '2026-09-01'))
    const rowidBefore = f.read('b-2').__rowid
    const movedBefore = f.read('d-1').__rowid
    f.state.onPut = () => { f.db.prepare('UPDATE strategy_decision_log SET evidence_json=? WHERE decision_id=?').run('{"newer":true}', 'b-2') }
    const result = await f.run()
    assert.equal(result.tables[0].status, 'failed')
    assert.match(String(result.tables[0].error), /audit_json_phase=scrub audit_json_source_changed_before_scrub/)
    assert.equal(f.read('b-2').evidence_json, '{"newer":true}')
    assert.equal(f.read('b-2').__rowid, rowidBefore)

    // The still-matching row committed in the same batch: it is counted and has a receipt.
    assert.equal(f.read('d-1').context_json, REF_CONTEXT)
    assert.notEqual(f.read('d-1').__rowid, movedBefore)
    assert.equal(result.tables[0].scrubbed_rows, 1)
    assert.equal(result.total_scrubbed_rows, 1)
    const item = f.db.prepare(`SELECT status, scrubbed_rows, evidence_json FROM data_retention_run_items WHERE dataset_id=?`).get(REF)!
    assert.equal(item.status, 'error')
    assert.equal(item.scrubbed_rows, 1)
    const receipt = JSON.parse(String(item.evidence_json))
    assert.equal(receipt.partial_commit, true)
    assert.equal(receipt.moved_rows, 1)
    assert.equal(receipt.new_rowid_min, f.read('d-1').__rowid)
    assert.match(receipt.rowid_map_digest, /^sha256:/)
    const cursor = f.db.prepare('SELECT status, cursor_key FROM data_retention_cursors WHERE dataset_id=?').get(REF)!
    assert.equal(cursor.status, 'error')
    assert.equal(cursor.cursor_key, null, 'cursor does not advance past a failed CAS page')
  } finally { f.db.close() }
})

test('a writer insert between attempts cannot collide with statement-local rowid numbering', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 6; i++) f.insert(familyRow('D', `d-${i}`, '2026-09-01'))
    assert.equal((await f.run({ limitPerTable: 3 })).total_scrubbed_rows, 3)
    f.insert(familyRow('D', 'writer-new', '2026-10-22'))
    const writerRowid = f.read('writer-new').__rowid
    assert.equal((await f.run({ limitPerTable: 3 })).total_scrubbed_rows, 3)
    const ids = f.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT rowid) d FROM strategy_decision_log').get()!
    assert.equal(ids.n, ids.d)
    assert.equal(f.read('writer-new').__rowid, writerRowid)
    for (let i = 3; i < 6; i++) assert(f.read(`d-${i}`).__rowid > writerRowid)
  } finally { f.db.close() }
})

test('a 1000-row attempt is one atomic batch, and an injected abort rolls every row back', async () => {
  const f = fixture()
  try {
    const tiny = (id: string) => ({
      decision_id: id, date: '2026-09-01', symbol: id, context_id: null, evidence_artifact_id: null,
      context_json: JSON.stringify({ schema_version: 'strategy-context-historical-matrix-projection-v1', producer_run_id: 'r' }),
      evidence_json: JSON.stringify({ schema_version: 'strategy-decision-historical-matrix-projection-v1', producer_run_id: 'r', no_lookahead: true }),
    })
    for (let i = 0; i < 1000; i++) f.insert(tiny(`t-${String(i).padStart(4, '0')}`))
    f.db.exec(`CREATE TRIGGER inject_abort BEFORE UPDATE ON strategy_decision_log
      WHEN OLD.decision_id='t-0990' BEGIN SELECT RAISE(ABORT,'injected_abort'); END`)
    const snapshot = () => f.db.prepare('SELECT rowid r, decision_id, context_json, evidence_json FROM strategy_decision_log ORDER BY decision_id').all()
    const before = snapshot()
    const failed = await f.run()
    assert.equal(failed.tables[0].status, 'failed')
    assert.match(String(failed.tables[0].error), /injected_abort/)
    assert.deepEqual(f.stats.scrubBatches, [50])
    assert.deepEqual(snapshot(), before, 'no partial rowid move or compaction survives')
    f.db.exec('DROP TRIGGER inject_abort')
    const ok = await f.run()
    assert.equal(ok.total_scrubbed_rows, 1000)
    assert.deepEqual(f.stats.scrubBatches, [50, 50])
  } finally { f.db.close() }
})

test('ref-v2 uses its own 7-day cutoff and ignores retention_days / min_blob_bytes', async () => {
  const f = fixture()
  try {
    f.insert(familyRow('D', 'd-1001', '2026-10-01'))
    f.insert(familyRow('D', 'd-1015', '2026-10-15'))
    f.insert(familyRow('D', 'd-1016', '2026-10-16'))
    const result = await f.run({ retentionDays: 30, minBlobBytes: 1024 })
    assert.equal(result.cutoff_date, '2026-09-23', 'run-level (legacy targets) cutoff still follows retention_days')
    assert.equal(result.tables[0].cutoff_date, HOT_CUTOFF)
    assert.equal(result.total_scrubbed_rows, 2)
    assert.equal(f.read('d-1016').context_json, familyRow('D', 'd-1016', '2026-10-16').context_json)
  } finally { f.db.close() }
})

test('KV gate is a per-attempt kill switch and opt-in targets are never implied', async () => {
  const f = fixture(null)
  try {
    f.insert(familyRow('A', 'a-1', '2026-08-01'))
    const before = { ...f.read('a-1') }
    const closed = await f.run()
    assert.deepEqual(closed.tables.map(table => [table.status, table.skipped_reason, table.backlog_remaining]), [['skipped', 'ref_v2_gate_off', false]])
    assert.equal(f.stats.puts, 0)
    assert.equal(f.ledgerRows(), 0, 'closed gate writes no ledger row')
    assert.deepEqual({ ...f.read('a-1') }, before)

    f.setGate('unknown-mode')
    assert.equal((await f.run()).tables[0].skipped_reason, 'ref_v2_gate_off')
    f.setGate('manual')
    const dry = await runAuditJsonArchiveRetention(f.env, { businessDate: BUSINESS_DATE, targets: [REF], limitPerTable: 500 })
    assert.equal(dry.tables[0].status, 'dry_run')
    assert.deepEqual(dry.tables[0].schema_histogram, { 'd1-audit-json-pointer-v1': 1 })
    const refEvidence = JSON.stringify({ schema_version: AUDIT_JSON_REF_V2_SCHEMA, archive: '0'.repeat(24) })
    assert.equal(dry.tables[0].planned_reclaimed_blob_bytes,
      Buffer.byteLength(before.context_json) + Buffer.byteLength(before.evidence_json)
      - Buffer.byteLength(REF_CONTEXT) - Buffer.byteLength(refEvidence))
    assert.equal(f.stats.puts, 0)
    assert.equal((await f.run()).total_scrubbed_rows, 1)
    f.setGate(null)
    f.insert(familyRow('A', 'a-2', '2026-08-02'))
    assert.equal((await f.run()).tables[0].skipped_reason, 'ref_v2_gate_off')
    assert.notEqual(f.read('a-2').context_json, REF_CONTEXT)

    assert(AUDIT_JSON_ARCHIVE_TARGET_IDS.includes(REF))
    assert(!AUDIT_JSON_DEFAULT_TARGET_IDS.includes(REF))
    await assert.rejects(buildAuditJsonRetentionPlan(f.env, { targets: [REF] }), /audit_json_plan_unbounded_use_dry_run/)
  } finally { f.db.close() }
})

test('moving rowids frees pages and every attempt records its physical size receipt', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 3000; i++) f.insert(familyRow('A', `a-${String(i).padStart(4, '0')}`, `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`))
    const usedBefore = f.usedBytes()
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await f.run()
      if (!result.tables[0].backlog_remaining) break
    }
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM strategy_decision_log WHERE context_json<>?`).get(REF_CONTEXT)!.n, 0)
    assert(f.pragma('freelist_count') / f.pragma('page_count') > 0.4, 'in-place shrink would leave the freelist empty')
    assert(f.usedBytes() < usedBefore * 0.6)
    const receipts = (f.db.prepare(`SELECT evidence_json FROM data_retention_run_items WHERE dataset_id=? AND status='success'`).all(REF) as any[])
      .map(row => JSON.parse(row.evidence_json))
    assert(receipts.length >= 2)
    for (const receipt of receipts) {
      assert(receipt.d1_size_after < receipt.d1_size_before, JSON.stringify(receipt))
      assert(receipt.moved_rows > 0)
      assert.match(receipt.rowid_map_digest, /^sha256:/)
      assert(receipt.new_rowid_max - receipt.new_rowid_min === receipt.moved_rows - 1)
    }
  } finally { f.db.close() }
})

// Durable drain + admin trigger wiring (same harness shape as maintenanceBacklogDrain.lifecycle.test.ts).
const activeKey = 'maintenance:backlog-drain:audit-json-retention:active'
const failureKey = 'maintenance:backlog-drain:audit-json-retention:failure'
const openWindow = new Date('2026-09-29T17:05:00Z')

function drainFixture(gate: 'manual' | 'scheduled' | null) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
  sql.exec('CREATE TABLE maintenance_task_leases(lease_group TEXT PRIMARY KEY, task_name TEXT, owner_id TEXT, lease_expires_at TEXT, acquired_at TEXT, heartbeat_at TEXT)')
  sql.exec('CREATE TABLE data_domain_cutovers(domain TEXT PRIMARY KEY, status TEXT)')
  for (const name of ['data_retention_policies', 'data_retention_runs', 'data_retention_run_items', 'data_retention_cursors',
    'dataset_snapshots', 'strategy_decision_log', 'paper_execution_events']) sql.exec(ddl(name))
  sql.exec("INSERT INTO data_retention_policies(policy_id,domain,dataset_pattern,hot_retention_days,cold_retention_days,archive_store,action,version,status,approved_reason) VALUES('audit_json_r2_v1','ops','*',90,3650,'r2','archive_scrub',1,'active','fixture')")
  // Two handles over one SQLite file, so a test can see which binding each lease query used.
  const leaseQueries = { legacy: 0, ops: 0 }
  const handle = (binding: keyof typeof leaseQueries): any => ({ prepare(query: string) {
    if (query.includes('maintenance_task_leases')) leaseQueries[binding]++
    let args: any[] = []
    const statement = { sql: query, bind(...values: any[]) { args = values; return statement },
      async first() { return sql.prepare(query).get(...args) ?? null },
      async all() { return { results: sql.prepare(query).all(...args), meta: { size_after: 0 } } },
      async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } } },
    }
    return statement
  }, async batch(statements: any[]) {
    sql.exec('BEGIN')
    try { const rows = []; for (const statement of statements) rows.push(await statement.run()); sql.exec('COMMIT'); return rows }
    catch (error) { sql.exec('ROLLBACK'); throw error }
  } })
  const db = handle('ops')
  const values = new Map<string, string>()
  if (gate) values.set(AUDIT_JSON_REF_V2_GATE_KEY, JSON.stringify({ mode: gate }))
  const messages: UpdateQueueMsg[] = []
  const delays: Array<number | undefined> = []
  const objects = new Map<string, string>()
  const env = { DB: handle('legacy'), OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test', CF_VERSION_METADATA: { id: 'version-a' },
    KV: { async get(key: string, type?: string) { const v = values.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
      async put(key: string, value: string) { values.set(key, value) }, async delete(key: string) { values.delete(key) } },
    UPDATE_QUEUE: { async send(message: UpdateQueueMsg, options?: { delaySeconds?: number }) { messages.push(message); delays.push(options?.delaySeconds) } },
    ARTIFACTS: {
      async put(key: string, body: string) { objects.set(key, body) },
      async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body } },
    },
  } as any
  for (let i = 0; i < 3; i++) {
    const row = familyRow('D', `d-${i}`, '2020-01-01')
    sql.prepare(`INSERT INTO strategy_decision_log(decision_id,date,symbol,strategy_id,strategy_version,strategy_status,alpha_bucket,reason_code,context_json,evidence_json)
      VALUES(?,?,?,'s','v1','active','trend','matched',?,?)`).run(row.decision_id, row.date, row.symbol, row.context_json, row.evidence_json)
  }
  const addPaperBacklog = () => {
    const raw = JSON.stringify({ source: 'unchanged original', padding: 'x'.repeat(1500) })
    for (let i = 1; i <= 3; i++) sql.prepare("INSERT INTO paper_execution_events(id,trade_date,symbol,side,event_type,status,detail_json) VALUES(?,'2020-01-01','2330','buy','entry','completed',?)").run(i, raw)
  }
  async function enqueue(runId: string, targets: string[]) {
    const { ticket } = await admitSchedulerExecutionTicket(db, {
      identity: { schedulerJobId: null, scheduledAt: null, ticketKind: 'manual' },
      task: 'audit-json-retention', requestedRunDate: '2026-09-29', proposedRunId: runId,
    })
    await enqueueMaintenanceBacklogDrain(env, { task: 'audit-json-retention', runDate: ticket.business_date, runId, maxCycles: 1,
      schedulerTicketId: ticket.ticket_id, schedulerRunId: runId,
      auditJsonOptions: { targets, retentionDays: 90, limitPerTable: 1, minBlobBytes: 1024 } })
    return ticket
  }
  const ticketRow = (id: string) => sql.prepare('SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(id)! as Record<string, any>
  const requestYield = () => sql.exec(`INSERT INTO maintenance_task_leases VALUES('d1_heavy_maintenance:yield-request',
    'yield-request:artifact-reconcile','waiter','2099-01-01 00:00:00','2026-09-29','2026-09-29')`)
  return { sql, db, env, values, messages, delays, enqueue, ticketRow, addPaperBacklog, requestYield, leaseQueries }
}

test('budget exhaustion with only opt-in backlog defers to the next night instead of a failure cooldown', async () => {
  const f = drainFixture('manual')
  try {
    const ticket = await f.enqueue('ref-v2-night-1', [REF])
    await processMaintenanceBacklogDrain(f.env, { ...f.messages[0], maxAttempts: 2 }, openWindow)
    await processMaintenanceBacklogDrain(f.env, f.messages[1], openWindow)
    const row = f.ticketRow(ticket.ticket_id)
    assert.equal(row.status, 'skipped', JSON.stringify(row))
    assert.match(String(row.last_summary), /deferred=opt_in_budget_exhausted backlog_remaining=true/)
    assert.equal(f.values.has(failureKey), false)
    assert.equal(f.values.has(`${failureKey}:${ticket.run_id}`), false)
    assert.equal(f.values.has(activeKey), false)
    assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM strategy_decision_log WHERE context_json=?`).get(REF_CONTEXT)!.n, 2)
    const next = await f.enqueue('ref-v2-night-2', [REF])
    assert.equal(f.ticketRow(next.ticket_id).status, 'running', 'the next night is admitted, not failure_cooldown')
  } finally { f.sql.close() }
})

test('budget exhaustion with any non-opt-in backlog keeps the fail-closed error', async () => {
  const f = drainFixture('manual')
  try {
    f.addPaperBacklog()
    const ticket = await f.enqueue('mixed-drain', [REF, 'paper_execution_events'])
    await processMaintenanceBacklogDrain(f.env, { ...f.messages[0], maxAttempts: 2 }, openWindow)
    await processMaintenanceBacklogDrain(f.env, f.messages[1], openWindow)
    assert.equal(f.ticketRow(ticket.ticket_id).status, 'error')
    assert.match(String(f.ticketRow(ticket.ticket_id).last_error), /maintenance_drain_budget_exhausted/)
    assert.equal(f.values.has(failureKey), true)
  } finally { f.sql.close() }
})

for (const [label, gate, query, targets, cycles] of [
  ['scheduled gate adds ref-v2 to the unnamed list with 8 cycles', 'scheduled', '', [...AUDIT_JSON_DEFAULT_TARGET_IDS, REF], 8],
  ['manual gate keeps the unnamed list and one cycle', 'manual', '', [...AUDIT_JSON_DEFAULT_TARGET_IDS], 1],
  ['named ref-v2 honours an explicit bounded max_cycles', 'manual', `&targets=${REF}&max_cycles=3`, [REF], 3],
  ['max_cycles is clamped to 8', 'manual', `&targets=${REF}&max_cycles=99`, [REF], 8],
] as const) test(`admin durable trigger: ${label}`, async () => {
  const f = drainFixture(gate)
  try {
    const { buildAdminWorkerDomainTaskMap } = await import('./adminTriggerWorkerDomainTasks')
    const routes = createAdminTriggerRoutes({ buildTaskMap: (c, context) => buildAdminWorkerDomainTaskMap(c, {} as any, context) })
    const response = await routes.request(`https://stockvision.invalid/api/admin/trigger/audit-json-retention?force=1&sync=1&durable=1&confirm_archive=${AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE}${query}`, { method: 'POST' }, f.env)
    assert.ok(response.ok, await response.clone().text())
    const message = f.messages.at(-1)!
    assert.deepEqual(message.maintenanceTargets, targets)
    assert.equal(message.maxMaintenanceCycles, cycles)
  } finally { f.sql.close() }
})

test('rows that cannot shrink are marked once, and rows with no JSON object are never selected', async () => {
  const f = fixture()
  try {
    const tiny = { context_id: null, evidence_artifact_id: null, date: '2026-08-01' }
    f.insert({ ...tiny, decision_id: 'empty-1', symbol: 'e1', context_json: '{}', evidence_json: '{}' })
    f.insert({ ...tiny, decision_id: 'hot-only', symbol: 'h1', context_json: '{}', evidence_json: JSON.stringify({ evaluability: { status: 'EVALUABLE' } }) })
    f.insert({ ...tiny, decision_id: 'array', symbol: 'a1', context_json: '[]', evidence_json: '[1,2,3]' })
    f.insert({ ...tiny, decision_id: 'invalid', symbol: 'i1', context_json: 'not-json', evidence_json: 'null' })
    const untouched = ['array', 'invalid'].map(id => ({ ...f.read(id) }))

    const first = await f.run()
    assert.equal(first.tables[0].candidate_rows, 2)
    assert.equal(first.total_scrubbed_rows, 2)
    for (const id of ['empty-1', 'hot-only']) {
      const evidence = JSON.parse(String(f.read(id).evidence_json))
      assert.equal(evidence.schema_version, AUDIT_JSON_REF_V2_SCHEMA, `${id} carries the marker`)
      assert.equal(f.read(id).context_json, '{}')
    }
    assert.deepEqual(JSON.parse(String(f.read('hot-only').evidence_json)).evaluability, { status: 'EVALUABLE' })
    assert.deepEqual(['array', 'invalid'].map(id => ({ ...f.read(id) })), untouched)

    const puts = f.stats.puts
    const second = await f.run()
    assert.equal(second.tables[0].candidate_rows, 0)
    assert.equal(second.tables[0].backlog_remaining, false, 'the drain can finish instead of rescanning forever')
    assert.equal(f.stats.puts, puts)
  } finally { f.db.close() }
})

test('scheduler summary shows the ref-v2 hot-window cutoff, not only the run-level 30-day cutoff', async () => {
  const f = fixture()
  try {
    f.insert(familyRow('D', 'd-1', '2026-09-01'))
    const result = await f.run({ targets: ['strategy_decision_log', REF], retentionDays: 30 })
    const summary = summarizeAuditJsonArchiveRun(result)
    assert.match(summary, /cutoff=2026-09-23 /)
    assert.match(summary, new RegExp(`${REF}:archived:[^ ]*:cutoff=${HOT_CUTOFF}`))
  } finally { f.db.close() }
})

test('the atomic-batch guard runs before any R2 or manifest write', () => {
  const source = readFileSync(new URL('./auditJsonArchive.ts', import.meta.url), 'utf8')
  const guard = source.indexOf("throw new Error('ref_v2_batch_not_atomic')")
  assert(guard > 0)
  assert(guard < source.indexOf('env.ARTIFACTS!.put('), 'guard precedes the R2 put')
  assert(guard < source.indexOf('upsertDatasetSnapshotManifest(env, manifest)'), 'guard precedes the manifest')
  assert.equal(source.split("'ref_v2_batch_not_atomic'").length, 2, 'single guard, no dead post-write copy')
})

test('exhaustion on the verification-only step still defers an opt-in backlog', async () => {
  const f = drainFixture('manual')
  try {
    // paper has nothing; ref-v2 drains its 3 rows on attempts 0-2, so attempt 2 ends
    // with full_target_verification_pending and the attempt budget used up.
    const ticket = await f.enqueue('verify-step', [REF, 'paper_execution_events'])
    await processMaintenanceBacklogDrain(f.env, { ...f.messages[0], maxAttempts: 3 }, openWindow)
    await processMaintenanceBacklogDrain(f.env, f.messages[1], openWindow)
    await processMaintenanceBacklogDrain(f.env, f.messages[2], openWindow)
    const row = f.ticketRow(ticket.ticket_id)
    assert.equal(row.status, 'skipped', JSON.stringify(row))
    assert.match(String(row.last_summary), /full_target_verification_pending=true/)
    assert.equal(f.values.has(failureKey), false)
  } finally { f.sql.close() }
})

test('an opt-in-only drain pauses 90s when another d1-heavy job asked for the lease', async () => {
  for (const [label, requested, targets, paper, delay] of [
    ['requested', true, [REF], false, 90],
    ['not requested', false, [REF], false, 5],
    ['mixed backlog ignores the request', true, [REF, 'paper_execution_events'], true, 5],
  ] as const) {
    const f = drainFixture('manual')
    try {
      if (paper) f.addPaperBacklog()
      if (requested) f.requestYield()
      await f.enqueue(`yield-${label}`, [...targets])
      await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
      assert.equal(f.messages.length, 2, label)
      assert.equal(f.messages[1].attempt, 1, `${label}: a yield does not consume an attempt`)
      assert.equal(f.delays[1], delay, label)
      assert.equal(f.leaseQueries.legacy, 0, `${label}: the lease and its yield request live only in Ops D1`)
      assert(f.leaseQueries.ops > 0, label)
    } finally { f.sql.close() }
  }
})

test('a waiting job asks the opt-in drain to yield and takes the lease in the gap', async () => {
  const f = drainFixture(null)
  try {
    f.sql.exec(`INSERT INTO maintenance_task_leases VALUES('d1_heavy_maintenance','audit-json-retention:queue','drain-owner','2099-01-01 00:00:00','x','x')`)
    const request = () => f.sql.prepare(`SELECT task_name FROM maintenance_task_leases WHERE lease_group='d1_heavy_maintenance:yield-request'`).get() as any
    let requestSeen: string | null = null
    const release = setTimeout(() => {
      requestSeen = request()?.task_name ?? null
      f.sql.exec(`DELETE FROM maintenance_task_leases WHERE owner_id='drain-owner'`)
    }, 500)
    let holderDuringRun: any = null
    const result = await runWithMaintenanceLeaseYielding(f.db, {
      taskName: 'artifact-reconcile', leaseGroup: 'd1_heavy_maintenance', leaseSeconds: 300,
      run: async () => { holderDuringRun = f.sql.prepare(`SELECT task_name FROM maintenance_task_leases WHERE lease_group='d1_heavy_maintenance'`).get(); return 'ran' },
    }, 5000)
    clearTimeout(release)
    assert.equal(result, 'ran')
    assert.equal(requestSeen, 'yield-request:artifact-reconcile')
    assert.equal(holderDuringRun?.task_name, 'artifact-reconcile')
    assert.equal(request(), undefined, 'the granted request is withdrawn')
    assert.equal(await maintenanceLeaseYieldRequested(f.db), null)

    // Any other holder keeps the old immediate skip and leaves no request behind.
    f.sql.exec(`INSERT INTO maintenance_task_leases VALUES('d1_heavy_maintenance','weekly-cleanup','other-owner','2099-01-01 00:00:00','x','x')`)
    const started = Date.now()
    const busy = await runWithMaintenanceLeaseYielding(f.db, { taskName: 'artifact-reconcile', run: async () => 'ran' }, 5000)
    assert(isMaintenanceLeaseBusy(busy))
    assert(Date.now() - started < 1000)
    assert.equal(request(), undefined)
  } finally { f.sql.close() }
})

test('lease callers opt into yielding: every d1-heavy wrapper except audit-json itself', () => {
  const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
  assert.match(read('adminTriggerWorkerDomainTasks.ts'), /taskName === 'audit-json-retention'\s*\? await runWithMaintenanceLease\(databaseForDataDomain\(c\.env, 'ops'\), lease\)\s*: await runWithMaintenanceLeaseYielding\(databaseForDataDomain\(c\.env, 'ops'\), lease, MAINTENANCE_LEASE_YIELD_WAIT_MS\)/)
  assert.match(read('maintenanceBacklogDrain.ts'), /runWithMaintenanceLeaseYielding\(databaseForDataDomain\(env, 'ops'\), \{\s*taskName: `\$\{task\}:queue`[\s\S]*?run: \(\) => runChunk\(env, task, msg, now\),\s*\}, 0\)/)
})

// Durable weekly-cleanup already locks on Ops D1 (durableSchedulerTaskContract); every
// other d1_heavy_maintenance holder and the backfill-lease readiness probe must use the same owner.
test('every d1_heavy_maintenance lease and lease probe uses the Ops D1 owner', () => {
  const lib = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
  const sources = {
    admin: lib('adminTriggerWorkerDomainTasks.ts'),
    drain: lib('maintenanceBacklogDrain.ts'),
    backfill: lib('dataDomainShadowBackfillDrain.ts'),
    adminRead: readFileSync(new URL('../routes/adminReadRoutes.ts', import.meta.url), 'utf8'),
    durable: lib('durableSchedulerTask.ts'),
    replan: lib('l4Replan.ts'),
    orchestrator: lib('pendingBuyOrchestrator.ts'),
  }
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /runWithMaintenanceLease(Yielding)?\(\s*(c\.)?env\.DB\b/, `${name}: no legacy env.DB lease`)
    assert.doesNotMatch(source, /maintenanceLeaseYieldRequested\(\s*(c\.)?env\.DB\b/, `${name}: no legacy env.DB yield probe`)
  }
  assert.equal(sources.backfill.split("runWithMaintenanceLease(databaseForDataDomain(env, 'ops'), {").length, 3)
  for (const source of [sources.admin, sources.adminRead]) {
    const probes = source.match(/inspectDataDomainBackfillRetirementReadiness\([^)]*\)[^)]*\)/g) ?? []
    assert(probes.length > 0)
    for (const probe of probes) assert.match(probe, /c\.env\.DB, c\.env\.KV, databaseForDataDomain\(c\.env, 'ops'\)/)
  }
})

test('the backfill-retirement readiness probe reads active leases from the lease database', async () => {
  const { inspectDataDomainBackfillRetirementReadiness } = await import('./dataDomainBackfillRetirementReadiness')
  const queries: string[] = []
  const empty = (label: string): any => ({ prepare(query: string) {
    queries.push(`${label}:${query.includes('maintenance_task_leases') ? 'lease' : 'control'}`)
    const statement = { bind: () => statement, all: async () => ({ results: [] }), first: async () => null }
    return statement
  } })
  const leaseRow = { lease_group: 'd1_heavy_maintenance', task_name: 'data-domain-shadow-backfill:ops', owner_id: 'o', lease_expires_at: '2099-01-01' }
  const opsDb: any = { prepare(query: string) {
    queries.push(`ops:${query.includes('maintenance_task_leases') ? 'lease' : 'control'}`)
    const statement = { bind: () => statement, all: async () => ({ results: [leaseRow] }), first: async () => null }
    return statement
  } }
  const readiness = await inspectDataDomainBackfillRetirementReadiness(empty('legacy'), { get: async () => null } as any, opsDb)
  assert.deepEqual(readiness.active_leases, [leaseRow])
  assert(readiness.blockers.includes('active_backfill_lease'))
  assert(!queries.includes('legacy:lease'))
  assert(!queries.includes('ops:control'), 'control-plane tables stay on the legacy handle')
})

test('the yield helper stays out of the native-paper bundle module', () => {
  // maintenanceLease.ts is bundled into native-paper.cjs; it must stay byte-identical to base.
  const lease = readFileSync(new URL('./maintenanceLease.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(lease, /yield/i)
})
