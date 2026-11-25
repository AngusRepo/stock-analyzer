/**
 * DRY-RUN ONLY planner: backfill the compact L0.5 liquidity receipt
 * (`evidence.l05_liquidity_capacity`) onto historical `scoring` rows of
 * OPS_DB.screener_funnel_items, sourced from each run's untruncated R2
 * `screener_funnel` evidence artifact.
 *
 * This tool has NO write mode. It only issues read-only SELECT / EXPLAIN QUERY
 * PLAN statements against stockvision-ops-db and read-only R2 object gets, and
 * writes plan files to a local directory. Every D1 read template is EXPLAINed
 * first and the tool aborts if any plan step is a table SCAN.
 *
 * Applying the emitted SQL is a production write and requires an explicit
 * Wei go (single executor, outside 01:00-07:00 Asia/Taipei so it cannot race
 * the audit-json-retention archive cron). See README section printed by --help.
 *
 * Usage (from repo root):
 *   worker/node_modules/.bin/tsx tools/screener_l05_receipt_backfill.ts \
 *     --from 2026-09-01 --to 2026-11-24 --out-dir output/screener_l05_receipt_backfill
 *   ... --run-id screener-v2-1795444661-f245a5d9      (single run, repeatable)
 *   ... --all-success-runs                             (default: latest run per date only,
 *                                                       which is what GET /recommendations/daily reads)
 *   ... --no-preimages                                 (skip pre-image capture)
 *   ... --emit-rollback <out>/preimages.jsonl.gz --rollback-out <file.sql>
 *                                                      (offline: build byte-exact pre-image restore SQL)
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGzip, gunzipSync } from 'node:zlib'
import {
  compactL05LiquidityCapacityReceipt,
  type L05LiquidityCapacityCompactReceipt,
  type L05LiquidityCapacityReceipt,
} from '../worker/src/lib/l05LiquidityCapacity'

export const OPS_DB = 'stockvision-ops-db'
export const ARTIFACT_BUCKET = 'stockvision-artifacts'
export const RECEIPT_KEY = 'l05_liquidity_capacity'
export const FUNNEL_ARTIFACT_SCHEMA = 'screener-funnel-evidence-v3'
export const POINTER_SCHEMAS = new Set([
  'd1-audit-json-pointer-v1',
  'legacy-screener-evidence-pointer-v1',
  'strategy-context-pointer-v1',
  'strategy-evidence-pointer-v1',
  'd1-audit-json-ref-v2',
])
const SQL_QUOTE = "'"

// ---------------------------------------------------------------------------
// Pure compute (unit tested in screener_l05_receipt_backfill.test.ts)
// ---------------------------------------------------------------------------

export interface ArtifactFunnelItem {
  symbol?: unknown
  stage?: unknown
  decision?: unknown
  evidence?: unknown
}

export interface ReceiptIndex {
  receipts: Map<string, L05LiquidityCapacityCompactReceipt>
  universeItems: number
  universeWithBoolPassed: number
  ambiguousSymbols: string[]
  policyChecksums: Record<string, number>
  artifactScoringAlreadyCarriesReceipt: number
}

/** Build symbol -> compact receipt from the untruncated artifact items. */
export function buildReceiptIndex(items: readonly ArtifactFunnelItem[]): ReceiptIndex {
  const receipts = new Map<string, L05LiquidityCapacityCompactReceipt>()
  const ambiguous = new Set<string>()
  const policyChecksums: Record<string, number> = {}
  let universeItems = 0
  let universeWithBoolPassed = 0
  let artifactScoringAlreadyCarriesReceipt = 0
  for (const item of items) {
    const evidence = item?.evidence
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) continue
    const symbol = typeof item.symbol === 'string' ? item.symbol.trim() : ''
    if (!symbol) continue
    if (item.stage === 'scoring' && RECEIPT_KEY in (evidence as Record<string, unknown>)) {
      artifactScoringAlreadyCarriesReceipt += 1
    }
    if (item.stage !== 'universe') continue
    universeItems += 1
    const record = evidence as Record<string, unknown>
    // Rows dropped before L0.5 ran (ETF, price, restriction, history) have no verdict.
    if (typeof record.passed !== 'boolean') continue
    universeWithBoolPassed += 1
    if (receipts.has(symbol)) {
      ambiguous.add(symbol)
      continue
    }
    const compact = compactL05LiquidityCapacityReceipt(record as unknown as L05LiquidityCapacityReceipt)
    const checksum = String(compact.policy_checksum ?? 'missing')
    policyChecksums[checksum] = (policyChecksums[checksum] ?? 0) + 1
    receipts.set(symbol, compact)
  }
  for (const symbol of ambiguous) receipts.delete(symbol)
  return {
    receipts,
    universeItems,
    universeWithBoolPassed,
    ambiguousSymbols: [...ambiguous].sort(),
    policyChecksums,
    artifactScoringAlreadyCarriesReceipt,
  }
}

export type ScoringRowClass =
  | 'plan_update'
  | 'already_has_receipt'
  | 'pointer'
  | 'invalid_json'
  | 'no_artifact_receipt'
  | 'not_json_object'
  | 'append_shape_unverified'

export interface D1ScoringRow {
  id: number
  symbol: string
  decision: string
  evidence: string | null
  valid: number | null
  schema_version: string | null
  l05_type: string | null
  roundtrip_ok: number | null
  append_ok: number | null
}

export function classifyScoringRow(
  row: D1ScoringRow,
  receipts: Map<string, L05LiquidityCapacityCompactReceipt>,
): ScoringRowClass {
  if (row.valid !== 1 || typeof row.evidence !== 'string') return 'invalid_json'
  if (row.schema_version && POINTER_SCHEMAS.has(row.schema_version)) return 'pointer'
  const trimmed = row.evidence.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return 'not_json_object'
  if (row.l05_type != null) return 'already_has_receipt'
  if (!receipts.has(String(row.symbol).trim())) return 'no_artifact_receipt'
  // json_set must append exactly `,"key":<receipt>}`; otherwise the predicted
  // post-image (and the CAS rollback) would be wrong for this row.
  if (row.append_ok !== 1 || row.evidence === '{}') return 'append_shape_unverified'
  return 'plan_update'
}

export function receiptJson(receipt: L05LiquidityCapacityCompactReceipt): string {
  return JSON.stringify(receipt)
}

/** SQLite json_set on a minified object lacking the key appends it at the end. */
export function predictedPostImage(preImage: string, receipt: L05LiquidityCapacityCompactReceipt): string {
  return `${preImage.slice(0, -1)},"${RECEIPT_KEY}":${receiptJson(receipt)}}`
}

export function sqlString(value: string): string {
  return SQL_QUOTE + value.split(SQL_QUOTE).join(SQL_QUOTE + SQL_QUOTE) + SQL_QUOTE
}

export function forwardUpdateSql(row: { id: number; run_id: string; evidence: string }, receipt: L05LiquidityCapacityCompactReceipt): string {
  return [
    'UPDATE screener_funnel_items',
    `   SET evidence = json_set(evidence, '$.${RECEIPT_KEY}', json(${sqlString(receiptJson(receipt))}))`,
    ` WHERE id = ${Number(row.id)} AND run_id = ${sqlString(row.run_id)} AND stage = 'scoring'`,
    // SQLite length(TEXT) counts characters; compare UTF-8 bytes instead.
    `   AND length(CAST(evidence AS BLOB)) = ${Buffer.byteLength(row.evidence, 'utf8')}`,
    '   AND json_valid(evidence) = 1',
    `   AND json_extract(evidence, '$.${RECEIPT_KEY}') IS NULL`,
    "   AND json_extract(evidence, '$.schema_version') IS NULL;",
  ].join('\n')
}

/**
 * Byte-exact restore of a saved pre-image. CAS: the row must still be exactly
 * the predicted post-image (byte length + the receipt we added), so a row that
 * changed after the backfill (e.g. archived to a pointer) is never overwritten.
 */
export function rollbackRestoreSql(row: { id: number; run_id: string; evidence: string }, receipt: L05LiquidityCapacityCompactReceipt): string {
  const post = predictedPostImage(row.evidence, receipt)
  return [
    `UPDATE screener_funnel_items SET evidence = ${sqlString(row.evidence)}`,
    ` WHERE id = ${Number(row.id)} AND run_id = ${sqlString(row.run_id)} AND stage = 'scoring'`,
    `   AND length(CAST(evidence AS BLOB)) = ${Buffer.byteLength(post, 'utf8')}`,
    `   AND json_valid(evidence) = 1`,
    `   AND json_extract(evidence, '$.${RECEIPT_KEY}') = ${sqlString(receiptJson(receipt))};`,
  ].join('\n')
}

export function rollbackJsonRemoveSql(row: { id: number; run_id: string }): string {
  return [
    `UPDATE screener_funnel_items SET evidence = json_remove(evidence, '$.${RECEIPT_KEY}')`,
    ` WHERE id = ${Number(row.id)} AND run_id = ${sqlString(row.run_id)} AND stage = 'scoring'`,
    `   AND json_valid(evidence) = 1 AND json_extract(evidence, '$.${RECEIPT_KEY}') IS NOT NULL;`,
  ].join('\n')
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

export const FUNNEL_INDEX_SCHEMA = 'screener-funnel-evidence-index-v1'
export const FUNNEL_CHUNK_SCHEMA = 'screener-funnel-evidence-chunk-v1'

export interface UniverseBlockRead {
  items: ArtifactFunnelItem[]
  storage: 'direct_v3' | 'chunked_index_v1'
  objects_read: number
  bytes_read: number
  chunks_total: number
  item_count: number | null
  universe_block_complete: boolean
}

/**
 * Read the artifact items up to the end of the contiguous `universe` block.
 * marketScreener pushes every `universe` item in Step 1 before any other stage,
 * so for a chunked artifact only the leading chunks are needed. Every object is
 * verified against the checksum bound by its (already verified) parent.
 */
export function readUniverseBlock(
  envelope: any,
  runDate: string,
  fetchVerified: (key: string, checksum: string) => { json: any; bytes: number },
): UniverseBlockRead {
  if (envelope?.domain !== 'screener_funnel' || envelope?.business_date !== runDate) {
    throw new Error('artifact_envelope_identity_mismatch')
  }
  if (envelope.schema_version === FUNNEL_ARTIFACT_SCHEMA) {
    if (!Array.isArray(envelope.payload?.items)) throw new Error('artifact_direct_items_missing')
    return {
      items: envelope.payload.items, storage: 'direct_v3', objects_read: 0, bytes_read: 0,
      chunks_total: 0, item_count: envelope.payload.items.length, universe_block_complete: true,
    }
  }
  const payload = envelope.payload
  if (envelope.schema_version !== FUNNEL_INDEX_SCHEMA || payload?.storage_mode !== 'chunked_r2_manifest_v1'
    || payload?.logical_schema_version !== FUNNEL_ARTIFACT_SCHEMA || !Array.isArray(payload?.chunks)
    || !Number.isSafeInteger(payload?.item_count)) {
    throw new Error('artifact_index_contract_mismatch')
  }
  const items: ArtifactFunnelItem[] = []
  let objects = 0
  let bytes = 0
  let complete = false
  let seenUniverse = false
  for (const [index, ref] of payload.chunks.entries()) {
    if (ref?.chunk_index !== index || ref?.schema_version !== FUNNEL_CHUNK_SCHEMA
      || ref?.row_start !== items.length || ref?.row_end_exclusive !== items.length + ref?.row_count
      || !/^sha256:[a-f0-9]{64}$/.test(String(ref?.checksum ?? ''))) {
      throw new Error(`artifact_chunk_reference_invalid:${index}`)
    }
    const child = fetchVerified(String(ref.r2_key), String(ref.checksum))
    objects += 1
    bytes += child.bytes
    const body = child.json?.payload
    if (child.json?.domain !== 'screener_funnel_chunk' || child.json?.business_date !== runDate
      || child.json?.schema_version !== FUNNEL_CHUNK_SCHEMA || body?.storage_mode !== 'chunked_r2_child_v1'
      || body?.logical_schema_version !== FUNNEL_ARTIFACT_SCHEMA || body?.chunk_index !== index
      || !Array.isArray(body?.items) || body.items.length !== ref.row_count) {
      throw new Error(`artifact_chunk_coverage_invalid:${index}`)
    }
    for (const item of body.items) {
      if (item?.stage === 'universe') {
        if (complete) throw new Error('artifact_universe_block_not_contiguous')
        seenUniverse = true
      } else if (seenUniverse) {
        complete = true
      } else if (items.length === 0 || items.every((prior) => prior?.stage !== 'universe')) {
        // A leading non-universe item means the contiguity assumption is unproven.
        throw new Error('artifact_universe_block_not_first')
      }
      items.push(item)
    }
    if (complete) break
  }
  if (!complete && items.length === payload.item_count) complete = seenUniverse
  return {
    items, storage: 'chunked_index_v1', objects_read: objects, bytes_read: bytes,
    chunks_total: payload.chunks.length, item_count: payload.item_count, universe_block_complete: complete,
  }
}

// ---------------------------------------------------------------------------
// Read-only I/O
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER_DIR = join(REPO_ROOT, 'worker')
const WRANGLER_JS = join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const READ_ONLY_SQL = /^\s*(EXPLAIN\s+QUERY\s+PLAN\s+)?(SELECT|WITH)\b/i
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|VACUUM|ATTACH|PRAGMA)\b/i

interface D1Meta { rows_read?: number; rows_written?: number; duration?: number }

function d1(sql: string): { results: any[]; meta: D1Meta } {
  // Hard read-only guard: the tool never sends anything but SELECT/EXPLAIN.
  if (!READ_ONLY_SQL.test(sql) || WRITE_KEYWORDS.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) {
    throw new Error(`refusing_non_readonly_sql:${sql.slice(0, 80)}`)
  }
  const out = execFileSync(process.execPath, [
    WRANGLER_JS, 'd1', 'execute', OPS_DB, '--remote', '--json', '--command', sql,
  ], { cwd: WORKER_DIR, maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const parsed = JSON.parse(out)
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (!first?.success) throw new Error(`d1_query_failed:${out.slice(0, 500)}`)
  if (Number(first.meta?.rows_written ?? 0) !== 0) throw new Error('unexpected_rows_written')
  return { results: first.results ?? [], meta: first.meta ?? {} }
}

const explained = new Map<string, string[]>()

/** EXPLAIN a query template once; abort if any step scans a table. */
function explainOnce(name: string, sql: string): string[] {
  const cached = explained.get(name)
  if (cached) return cached
  const { results } = d1(`EXPLAIN QUERY PLAN ${sql}`)
  const details = results.map((row) => String(row.detail ?? ''))
  const scans = details.filter((detail) => /^SCAN\b/.test(detail.trim()) && !/^SCAN CONSTANT ROW/.test(detail.trim()))
  if (scans.length) throw new Error(`explain_scan_refused:${name}:${scans.join(' | ')}`)
  explained.set(name, details)
  return details
}

function readOnly(name: string, sql: string): { results: any[]; meta: D1Meta } {
  explainOnce(name, sql)
  return d1(sql)
}

function r2Get(key: string): Buffer {
  return execFileSync(process.execPath, [
    WRANGLER_JS, 'r2', 'object', 'get', `${ARTIFACT_BUCKET}/${key}`, '--remote', '--pipe',
  ], { cwd: WORKER_DIR, maxBuffer: 2 * 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

const PROBE_RECEIPT = '{"policy_checksum":"sha256:probe","observed_sessions":20,"median_daily_traded_value_twd":123456789,"mean_daily_traded_value_twd":-1,"min_median_daily_traded_value_twd":0,"passed":true}'

const SQL = {
  runs: (from: string, to: string) => `
    SELECT run_id, date, status, created_at, universe_count, candidate_count
      FROM screener_funnel_runs
     WHERE date >= ${sqlString(from)} AND date <= ${sqlString(to)}
     ORDER BY date, created_at`,
  pipelineRun: (runId: string) => `
    SELECT run_id, status, artifact_id FROM pipeline_runs WHERE run_id = ${sqlString(runId)}`,
  artifacts: (runId: string) => `
    SELECT artifact_id, r2_key, checksum, byte_size, row_count, status, payload_deleted_at,
           schema_version, retention_class, business_date
      FROM run_artifacts
     WHERE producer_run_id = ${sqlString(runId)} AND domain = 'screener_funnel'`,
  canonicalHead: (date: string) => `
    SELECT run_id FROM canonical_run_heads
     WHERE logical_run_key = ${sqlString(`screener:${date}:TW:production:market_screener`)}`,
  stageCounts: (runId: string) => `
    SELECT stage, decision, COUNT(*) AS n
      FROM screener_funnel_items
     WHERE run_id = ${sqlString(runId)} AND stage IN ('universe', 'scoring')
     GROUP BY stage, decision`,
  scoring: (runId: string, withEvidence: boolean) => `
    SELECT id, symbol, decision,
           ${withEvidence ? 'evidence,' : ''}
           length(evidence) AS evidence_bytes,
           json_valid(evidence) AS valid,
           CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.schema_version') END AS schema_version,
           CASE WHEN json_valid(evidence) THEN json_type(evidence, '$.${RECEIPT_KEY}') END AS l05_type,
           CASE WHEN json_valid(evidence) THEN
             evidence = json_remove(json_set(evidence, '$.${RECEIPT_KEY}', json('${PROBE_RECEIPT}')), '$.${RECEIPT_KEY}')
           END AS roundtrip_ok,
           CASE WHEN json_valid(evidence) THEN
             json_set(evidence, '$.${RECEIPT_KEY}', json('${PROBE_RECEIPT}'))
               = substr(evidence, 1, length(evidence) - 1) || ',"${RECEIPT_KEY}":${PROBE_RECEIPT}}'
           END AS append_ok
      FROM screener_funnel_items
     WHERE run_id = ${sqlString(runId)} AND stage = 'scoring'`,
  universeSymbols: (runId: string) => `
    SELECT symbol FROM screener_funnel_items
     WHERE run_id = ${sqlString(runId)} AND stage = 'universe' AND decision = 'pass'`,
  scrubQueue: () => `
    SELECT target_pk_value, status FROM artifact_d1_scrub_queue
     WHERE status IN ('pending', 'running', 'failed') AND target_table = 'screener_funnel_items'`,
  // Constant-row check that SQLite re-renders our receipt text byte-identically.
  receiptRender: (receipts: string[]) => `SELECT ${receipts.length
    ? receipts.map((text, index) => `(json(${sqlString(text)}) = ${sqlString(text)}) AS r${index}`).join(', ')
    : '1 AS r0'}`,
  // Read-only proof on real rows/receipts that the forward guard matches and json_set
  // yields exactly the predicted post-image (byte length + appended suffix).
  postVerify: (rows: { id: number; bytes: number; receipt: string; postBytes: number }[]) => rows.map(({ id, bytes, receipt, postBytes }) => `
    SELECT id,
           (length(CAST(evidence AS BLOB)) = ${bytes} AND json_valid(evidence) = 1
             AND json_extract(evidence, '$.${RECEIPT_KEY}') IS NULL
             AND json_extract(evidence, '$.schema_version') IS NULL) AS guard_ok,
           (json_set(evidence, '$.${RECEIPT_KEY}', json(${sqlString(receipt)}))
             = substr(evidence, 1, length(evidence) - 1) || ${sqlString(`,"${RECEIPT_KEY}":${receipt}}`)}) AS append_exact,
           (length(CAST(json_set(evidence, '$.${RECEIPT_KEY}', json(${sqlString(receipt)})) AS BLOB)) = ${postBytes}) AS post_bytes_ok,
           (json_remove(json_set(evidence, '$.${RECEIPT_KEY}', json(${sqlString(receipt)})), '$.${RECEIPT_KEY}') = evidence) AS remove_exact
      FROM screener_funnel_items WHERE id = ${Number(id)}`).join('\n    UNION ALL'),
  // Templates of the eventual write, EXPLAINed (EXPLAIN never executes it) for the report.
  explainForwardWrite: `EXPLAIN QUERY PLAN UPDATE screener_funnel_items SET evidence = json_set(evidence, '$.${RECEIPT_KEY}', json('{}')) WHERE id = 1 AND run_id = 'x' AND stage = 'scoring' AND length(CAST(evidence AS BLOB)) = 1 AND json_valid(evidence) = 1 AND json_extract(evidence, '$.${RECEIPT_KEY}') IS NULL AND json_extract(evidence, '$.schema_version') IS NULL`,
  explainRollbackRestore: `EXPLAIN QUERY PLAN UPDATE screener_funnel_items SET evidence = '{}' WHERE id = 1 AND run_id = 'x' AND stage = 'scoring' AND length(CAST(evidence AS BLOB)) = 1 AND json_valid(evidence) = 1 AND json_extract(evidence, '$.${RECEIPT_KEY}') = '{}'`,
  explainRollbackRemove: `EXPLAIN QUERY PLAN UPDATE screener_funnel_items SET evidence = json_remove(evidence, '$.${RECEIPT_KEY}') WHERE id = 1 AND run_id = 'x' AND stage = 'scoring' AND json_valid(evidence) = 1 AND json_extract(evidence, '$.${RECEIPT_KEY}') IS NOT NULL`,
}

function explainWriteTemplate(sql: string): string[] {
  // EXPLAIN QUERY PLAN of an UPDATE only plans it; it changes nothing. The
  // generic read-only guard rejects UPDATE text, so call wrangler directly.
  if (!/^EXPLAIN QUERY PLAN UPDATE /.test(sql)) throw new Error('explain_write_template_invalid')
  const out = execFileSync(process.execPath, [
    WRANGLER_JS, 'd1', 'execute', OPS_DB, '--remote', '--json', '--command', sql,
  ], { cwd: WORKER_DIR, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const first = JSON.parse(out)[0]
  if (Number(first.meta?.rows_written ?? 0) !== 0 || Number(first.meta?.changes ?? 0) !== 0) {
    throw new Error('explain_write_template_changed_rows')
  }
  return (first.results ?? []).map((row: any) => String(row.detail ?? ''))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function flagValues(argv: string[], name: string): string[] {
  const values: string[] = []
  argv.forEach((arg, index) => { if (arg === name && argv[index + 1]) values.push(argv[index + 1]) })
  return values
}

function taipeiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help')) {
    console.log(readmeText())
    return
  }
  if (argv.includes('--apply') || argv.includes('--write')) {
    throw new Error('write_mode_not_implemented: this tool is dry-run only; applying the plan is a prod write that requires Wei go')
  }
  const emitRollback = flagValues(argv, '--emit-rollback')[0]
  if (emitRollback) {
    // Offline: no D1/R2 access. Pre-image restore SQL is ~1x the pre-image bytes
    // (~20 MB per run uncompressed), so it is only materialized when needed.
    const target = flagValues(argv, '--rollback-out')[0]
    if (!target) throw new Error('--rollback-out <file.sql> required with --emit-rollback')
    const lines = gunzipSync(readFileSync(emitRollback)).toString('utf8').split('\n').filter(Boolean)
    const out = createWriteStream(target)
    out.write('-- DO NOT EXECUTE without Wei go. Byte-exact pre-image restore (CAS: row still holds the backfilled receipt and post-image length).\n\n')
    let count = 0
    for (const line of lines) {
      const row = JSON.parse(line)
      if (sha256Hex(row.preimage) !== row.preimage_sha256) throw new Error(`preimage_sha256_mismatch:${row.id}`)
      out.write(`${rollbackRestoreSql({ id: row.id, run_id: row.run_id, evidence: row.preimage }, row.receipt)}\n`)
      count += 1
    }
    await new Promise((done) => out.end(done))
    console.log(JSON.stringify({ rollback_out: target, statements: count }))
    return
  }
  const from = flagValues(argv, '--from')[0] ?? '2026-09-01'
  const to = flagValues(argv, '--to')[0] ?? taipeiToday()
  const onlyRuns = new Set(flagValues(argv, '--run-id'))
  const allSuccessRuns = argv.includes('--all-success-runs')
  const withPreimages = !argv.includes('--no-preimages')
  const outDir = resolve(flagValues(argv, '--out-dir')[0] ?? join(REPO_ROOT, 'output', 'screener_l05_receipt_backfill'))
  mkdirSync(outDir, { recursive: true })

  const started = Date.now()
  const runRows = readOnly('runs', SQL.runs(from, to)).results
  const byDate = new Map<string, any[]>()
  for (const run of runRows) byDate.set(run.date, [...(byDate.get(run.date) ?? []), run])
  let targets: any[] = []
  for (const runs of byDate.values()) {
    if (allSuccessRuns) targets.push(...runs.filter((run) => run.status === 'success'))
    else {
      // GET /recommendations/daily reads the latest run per date regardless of status.
      const latest = runs[runs.length - 1]
      if (latest.status === 'success') targets.push(latest)
    }
  }
  if (onlyRuns.size) targets = targets.filter((run) => onlyRuns.has(run.run_id))

  const scrubRows = readOnly('scrub_queue', SQL.scrubQueue()).results
  const scrubIds = new Map(scrubRows.map((row) => [String(row.target_pk_value), String(row.status)]))

  const forward = createWriteStream(join(outDir, 'planned_forward_updates.sql'))
  const rollbackRemove = createWriteStream(join(outDir, 'rollback_json_remove.sql'))
  const preimageGzip = withPreimages ? createGzip() : null
  if (preimageGzip) preimageGzip.pipe(createWriteStream(join(outDir, 'preimages.jsonl.gz')))
  const header = '-- DO NOT EXECUTE without Wei go. Generated by tools/screener_l05_receipt_backfill.ts (dry-run).\n'
    + '-- Target: stockvision-ops-db. Run outside 01:00-07:00 Asia/Taipei (audit-json-retention archive window).\n\n'
  forward.write(header)
  rollbackRemove.write(header + '-- Fallback rollback: json_remove. Byte-identical only for rows with roundtrip_ok=1 (see plan_summary.json).\n\n')

  const perRun: any[] = []
  const totals: Record<string, number> = {
    runs: 0, runs_skipped: 0, scoring_rows: 0, planned_updates: 0, planned_bytes_added: 0,
    planned_rows_with_d1_universe_row: 0, pointer_rows: 0, already_has_receipt: 0, invalid_json: 0,
    no_artifact_receipt: 0, not_json_object: 0, append_shape_unverified: 0, roundtrip_not_ok: 0,
    r2_bytes_read: 0, d1_rows_read: 0, scrub_queue_conflicts: 0, receipt_render_mismatch: 0,
  }
  for (const run of targets) {
    const runStarted = Date.now()
    const record: any = { run_id: run.run_id, date: run.date, status: run.status }
    let rowsRead = 0
    try {
      const pipeline = readOnly('pipeline_run', SQL.pipelineRun(run.run_id))
      const artifacts = readOnly('run_artifacts', SQL.artifacts(run.run_id))
      const head = readOnly('canonical_head', SQL.canonicalHead(run.date))
      rowsRead += Number(pipeline.meta.rows_read ?? 0) + Number(artifacts.meta.rows_read ?? 0) + Number(head.meta.rows_read ?? 0)
      record.canonical_head = head.results[0]?.run_id === run.run_id
      const pipelineArtifactId = pipeline.results[0]?.artifact_id ?? null
      const candidates = artifacts.results.filter((row) =>
        (row.schema_version === FUNNEL_ARTIFACT_SCHEMA || row.schema_version === FUNNEL_INDEX_SCHEMA)
        && row.business_date === run.date && !row.payload_deleted_at && row.status === 'ready')
      const artifact = candidates.find((row) => row.artifact_id === pipelineArtifactId)
        ?? (candidates.length === 1 ? candidates[0] : null)
      if (!artifact) {
        record.skip_reason = `artifact_unresolved:pipeline=${pipelineArtifactId}:candidates=${candidates.length}`
        totals.runs_skipped += 1
        perRun.push(record)
        continue
      }
      record.artifact_id = artifact.artifact_id
      record.r2_key = artifact.r2_key
      const r2Started = Date.now()
      const body = r2Get(artifact.r2_key)
      record.r2_ms = Date.now() - r2Started
      record.r2_bytes = body.length
      const checksum = `sha256:${sha256Hex(body)}`
      if (checksum !== artifact.checksum) {
        record.skip_reason = 'artifact_checksum_mismatch'
        totals.runs_skipped += 1
        perRun.push(record)
        continue
      }
      const parsed = JSON.parse(body.toString('utf8'))
      if (parsed?.schema_version !== artifact.schema_version) throw new Error('artifact_schema_mismatch')
      const block = readUniverseBlock(parsed, run.date, (key, expected) => {
        const child = r2Get(key)
        if (`sha256:${sha256Hex(child)}` !== expected) throw new Error(`artifact_chunk_checksum_mismatch:${key}`)
        return { json: JSON.parse(child.toString('utf8')), bytes: child.length }
      })
      record.r2_ms = Date.now() - r2Started
      record.r2_bytes = body.length + block.bytes_read
      record.r2_objects = 1 + block.objects_read
      record.artifact_storage = block.storage
      record.artifact_chunks_total = block.chunks_total
      record.artifact_item_count = block.item_count
      if (!block.universe_block_complete) throw new Error('artifact_universe_block_incomplete')
      const index = buildReceiptIndex(block.items)
      record.artifact_items_read = block.items.length
      // Completeness: universe pass items must equal the run's persisted universe_count.
      const universePass = block.items.filter((item) => item.stage === 'universe' && item.decision === 'pass').length
      record.artifact_universe_pass = universePass
      record.run_universe_count = run.universe_count
      if (universePass !== Number(run.universe_count)) throw new Error(`artifact_universe_count_mismatch:${universePass}/${run.universe_count}`)
      record.artifact_universe_items = index.universeItems
      record.artifact_universe_with_receipt = index.universeWithBoolPassed
      record.artifact_scoring_already_has_receipt = index.artifactScoringAlreadyCarriesReceipt
      record.ambiguous_symbols = index.ambiguousSymbols.length
      record.policy_checksums = index.policyChecksums

      const counts = readOnly('stage_counts', SQL.stageCounts(run.run_id))
      const universe = readOnly('universe_symbols', SQL.universeSymbols(run.run_id))
      const scoring = readOnly(withPreimages ? 'scoring_with_evidence' : 'scoring_projection', SQL.scoring(run.run_id, withPreimages))
      rowsRead += Number(counts.meta.rows_read ?? 0) + Number(universe.meta.rows_read ?? 0) + Number(scoring.meta.rows_read ?? 0)
      record.d1_stage_counts = Object.fromEntries(counts.results.map((row) => [`${row.stage}:${row.decision}`, row.n]))
      const universeSymbols = new Set(universe.results.map((row) => String(row.symbol).trim()))

      const classes: Record<string, number> = {}
      const pointerSchemas: Record<string, number> = {}
      let bytesAdded = 0
      let withUniverse = 0
      let roundtripNotOk = 0
      let scrubConflicts = 0
      const planned: { row: D1ScoringRow; receipt: L05LiquidityCapacityCompactReceipt }[] = []
      for (const row of scoring.results as D1ScoringRow[]) {
        const klass = classifyScoringRow(row, index.receipts)
        classes[klass] = (classes[klass] ?? 0) + 1
        if (klass === 'pointer') pointerSchemas[String(row.schema_version)] = (pointerSchemas[String(row.schema_version)] ?? 0) + 1
        if (klass !== 'plan_update') continue
        if (scrubIds.has(String(row.id))) { scrubConflicts += 1; continue }
        const receipt = index.receipts.get(String(row.symbol).trim())!
        planned.push({ row, receipt })
        bytesAdded += Buffer.byteLength(`,"${RECEIPT_KEY}":${receiptJson(receipt)}`, 'utf8')
        if (universeSymbols.has(String(row.symbol).trim())) withUniverse += 1
        if (row.roundtrip_ok !== 1) roundtripNotOk += 1
      }
      // Verify SQLite renders a sample of the real receipts byte-identically (constant row, 0 rows read).
      const sample = [...new Set(planned.slice(0, 40).map(({ receipt }) => receiptJson(receipt)))]
      const render = d1(SQL.receiptRender(sample))
      const renderMismatch = Object.values(render.results[0] ?? {}).filter((value) => value !== 1).length

      const verifySample = planned.filter(({ row }) => typeof row.evidence === 'string').slice(0, 5).map(({ row, receipt }) => ({
        id: row.id,
        bytes: Buffer.byteLength(row.evidence!, 'utf8'),
        receipt: receiptJson(receipt),
        postBytes: Buffer.byteLength(predictedPostImage(row.evidence!, receipt), 'utf8'),
      }))
      const postVerify = verifySample.length ? readOnly('post_verify_by_pk', SQL.postVerify(verifySample)) : null
      rowsRead += Number(postVerify?.meta.rows_read ?? 0)
      record.post_verify = postVerify?.results ?? []
      const postVerifyFailures = (postVerify?.results ?? []).filter((row) =>
        row.guard_ok !== 1 || row.append_exact !== 1 || row.post_bytes_ok !== 1 || row.remove_exact !== 1).length
      totals.post_verify_failures = (totals.post_verify_failures ?? 0) + postVerifyFailures

      for (const { row, receipt } of planned) {
        if (!withPreimages || typeof row.evidence !== 'string') continue
        const rowRef = { id: row.id, run_id: run.run_id, evidence: row.evidence }
        forward.write(`${forwardUpdateSql(rowRef, receipt)}\n`)
        rollbackRemove.write(`${rollbackJsonRemoveSql(rowRef)}\n`)
        preimageGzip?.write(`${JSON.stringify({
          id: row.id, run_id: run.run_id, date: run.date, symbol: row.symbol,
          preimage_sha256: sha256Hex(row.evidence), preimage_bytes: Buffer.byteLength(row.evidence, 'utf8'),
          postimage_sha256: sha256Hex(predictedPostImage(row.evidence, receipt)),
          receipt, preimage: row.evidence,
        })}\n`)
      }
      Object.assign(record, {
        d1_scoring_rows: scoring.results.length,
        classes,
        pointer_schemas: pointerSchemas,
        planned_updates: planned.length,
        planned_bytes_added: bytesAdded,
        planned_rows_with_d1_universe_row: withUniverse,
        roundtrip_not_ok: roundtripNotOk,
        scrub_queue_conflicts: scrubConflicts,
        receipt_render_sampled: sample.length,
        receipt_render_mismatch: renderMismatch,
        d1_rows_read: rowsRead,
        wall_ms: Date.now() - runStarted,
      })
      totals.runs += 1
      totals.scoring_rows += scoring.results.length
      totals.planned_updates += planned.length
      totals.planned_bytes_added += bytesAdded
      totals.planned_rows_with_d1_universe_row += withUniverse
      totals.pointer_rows += classes.pointer ?? 0
      totals.already_has_receipt += classes.already_has_receipt ?? 0
      totals.invalid_json += classes.invalid_json ?? 0
      totals.no_artifact_receipt += classes.no_artifact_receipt ?? 0
      totals.not_json_object += classes.not_json_object ?? 0
      totals.append_shape_unverified += classes.append_shape_unverified ?? 0
      totals.roundtrip_not_ok += roundtripNotOk
      totals.r2_bytes_read += record.r2_bytes
      totals.d1_rows_read += rowsRead
      totals.scrub_queue_conflicts += scrubConflicts
      totals.receipt_render_mismatch += renderMismatch
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      totals.runs_skipped += 1
      if (record.error.startsWith('explain_scan_refused')) {
        perRun.push(record)
        break
      }
    }
    perRun.push(record)
    console.error(`[l05-backfill] ${run.date} ${run.run_id} planned=${record.planned_updates ?? 0} pointer=${record.classes?.pointer ?? 0} wall_ms=${record.wall_ms ?? '-'}${record.skip_reason ? ` skip=${record.skip_reason}` : ''}${record.error ? ` error=${record.error}` : ''}`)
  }

  const writeExplain = {
    forward_update: explainWriteTemplate(SQL.explainForwardWrite),
    rollback_restore: explainWriteTemplate(SQL.explainRollbackRestore),
    rollback_json_remove: explainWriteTemplate(SQL.explainRollbackRemove),
  }
  await Promise.all([forward, rollbackRemove].map((stream) =>
    new Promise((done) => stream!.end(done))))
  if (preimageGzip) await new Promise((done) => preimageGzip.end(done))

  const summary = {
    schema_version: 'screener-l05-receipt-backfill-plan-v1',
    mode: 'dry_run_only',
    generated_at: new Date().toISOString(),
    window: { from, to },
    selection: allSuccessRuns ? 'all_success_runs' : 'latest_run_per_date_if_success',
    totals: {
      ...totals,
      // Updating a non-indexed TEXT column: 1 row written per updated row (no index covers evidence).
      estimated_d1_rows_written: totals.planned_updates,
      wall_ms: Date.now() - started,
    },
    explain_plans: { ...Object.fromEntries(explained), ...writeExplain },
    files: {
      forward: 'planned_forward_updates.sql',
      rollback_restore: withPreimages ? 'generate offline: --emit-rollback <preimages.jsonl.gz> --rollback-out <file.sql>' : null,
      rollback_json_remove: 'rollback_json_remove.sql',
      preimages: withPreimages ? 'preimages.jsonl.gz' : null,
    },
    runs: perRun,
  }
  writeFileSync(join(outDir, 'plan_summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ out_dir: outDir, totals: summary.totals }, null, 2))
}

function readmeText(): string {
  return `screener_l05_receipt_backfill (DRY-RUN ONLY, no write mode)

Reads stockvision-ops-db (SELECT / EXPLAIN only, SCAN plans refused) and the
R2 screener_funnel evidence artifacts (stockvision-artifacts, object get only),
and writes into --out-dir:
  plan_summary.json                per-run counts, EXPLAIN plans, timings
  planned_forward_updates.sql      json_set UPDATEs with CAS guards (NOT executed)
  rollback_json_remove.sql         json_remove rollback (byte-exact iff roundtrip_not_ok == 0)
  preimages.jsonl.gz               full pre-image text + sha256 per planned row
Offline: --emit-rollback <preimages.jsonl.gz> --rollback-out <file.sql>
  builds the byte-exact pre-image restore SQL (CAS on receipt + post-image length).

Applying planned_forward_updates.sql is a production D1 write: it requires an
explicit Wei go, a single executor, a fresh dry-run immediately before apply
(pre-images must be current), and must run outside 01:00-07:00 Asia/Taipei.
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
