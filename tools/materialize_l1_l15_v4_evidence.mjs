import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB = 'stockvision-learning-db'
const ROUTE_VERSION = 'strategy-semantic-continuous-affinity-v4'
const INPUT = join('output', 'l1_l15_route_repair_comparison', 'semantic_v4_evidence_rows.json')
const WRANGLER = join('worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const CONFIRM = process.argv.includes('--confirm-production-effect-none')

function flag(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}

function sqlText(value) {
  return "'" + String(value ?? '').replaceAll("'", "''") + "'"
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function execute(sql) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = execFileSync(
        process.execPath,
        [WRANGLER, 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
        { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: process.env, timeout: 60_000 },
      )
      const start = raw.indexOf('[')
      if (start < 0) throw new Error('d1_json_payload_missing')
      const payload = JSON.parse(raw.slice(start))
      if (!payload?.[0]?.success) throw new Error('d1_query_failed')
      return payload[0]
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const trackedStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
if (trackedStatus) throw new Error('materializer_requires_clean_tracked_worktree')

const expectedSourceSha = flag('--expected-source-sha')
if (expectedSourceSha && expectedSourceSha !== sourceSha) {
  throw new Error('source_sha_mismatch:' + sourceSha + ':' + expectedSourceSha)
}

const inputRows = JSON.parse(readFileSync(INPUT, 'utf8'))
if (!Array.isArray(inputRows) || inputRows.length === 0) throw new Error('v4_evidence_rows_empty')
const expectedRows = Number(flag('--expected-rows', String(inputRows.length)))
const expectedDates = Number(flag('--expected-dates', String(new Set(inputRows.map((row) => row.signal_date)).size)))
if (inputRows.length !== expectedRows) throw new Error('expected_row_count_mismatch:' + inputRows.length + ':' + expectedRows)

const keys = new Set()
const coreRows = inputRows.map((input) => {
  const row = {
    route_version: String(input.route_version),
    signal_date: String(input.signal_date),
    symbol: String(input.symbol).trim().toUpperCase(),
    producer_run_id: String(input.producer_run_id),
    route_score: Number(input.route_score),
    incumbent_route_version: String(input.incumbent_route_version),
    incumbent_route_score: input.incumbent_route_score == null ? null : Number(input.incumbent_route_score),
    strategy_spec_version: String(input.strategy_spec_version),
    evidence_method: String(input.evidence_method),
    source_reference_contract: String(input.source_reference_contract),
  }
  if (row.route_version !== ROUTE_VERSION) throw new Error('route_version_mismatch')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.signal_date)) throw new Error('invalid_signal_date:' + row.signal_date)
  if (!row.symbol || !row.producer_run_id) throw new Error('identity_missing:' + row.signal_date)
  if (!Number.isFinite(row.route_score) || row.route_score < 0 || row.route_score > 100) {
    throw new Error('invalid_route_score:' + row.signal_date + ':' + row.symbol)
  }
  if (row.incumbent_route_score != null && !Number.isFinite(row.incumbent_route_score)) {
    throw new Error('invalid_incumbent_route_score:' + row.signal_date + ':' + row.symbol)
  }
  if (row.strategy_spec_version !== 'strategy-spec-v2') throw new Error('strategy_spec_version_mismatch')
  if (row.evidence_method !== 'deterministic_paired_pit_replay') throw new Error('evidence_method_mismatch')
  const key = [row.route_version, row.signal_date, row.symbol, row.producer_run_id].join('|')
  if (keys.has(key)) throw new Error('duplicate_evidence_key:' + key)
  keys.add(key)
  return row
}).sort((left, right) =>
  left.signal_date.localeCompare(right.signal_date)
  || left.symbol.localeCompare(right.symbol)
  || left.producer_run_id.localeCompare(right.producer_run_id)
)

const dates = [...new Set(coreRows.map((row) => row.signal_date))].sort()
if (dates.length !== expectedDates) throw new Error('expected_date_count_mismatch:' + dates.length + ':' + expectedDates)
const artifactChecksum = sha256(JSON.stringify(coreRows))
const evidenceArtifactId = 'strategy-route-evidence-v4-' + artifactChecksum.slice(0, 24)
const rows = coreRows.map((row) => ({
  ...row,
  evidence_artifact_id: evidenceArtifactId,
  source_sha: sourceSha,
  row_checksum: sha256(JSON.stringify({ ...row, evidence_artifact_id: evidenceArtifactId, source_sha: sourceSha })),
  artifact_checksum: artifactChecksum,
  production_effect: 0,
}))

const existing = execute(
  'SELECT route_version,signal_date,symbol,producer_run_id,row_checksum,artifact_checksum,production_effect '
  + 'FROM strategy_route_versioned_evidence_v1 WHERE route_version=' + sqlText(ROUTE_VERSION)
  + ' AND signal_date IN (' + dates.map(sqlText).join(',') + ') ORDER BY signal_date,symbol,producer_run_id',
).results ?? []
const expectedByKey = new Map(rows.map((row) => [[row.route_version, row.signal_date, row.symbol, row.producer_run_id].join('|'), row]))
for (const row of existing) {
  const key = [row.route_version, row.signal_date, String(row.symbol).toUpperCase(), row.producer_run_id].join('|')
  const expected = expectedByKey.get(key)
  if (!expected || row.row_checksum !== expected.row_checksum || row.artifact_checksum !== artifactChecksum || Number(row.production_effect) !== 0) {
    throw new Error('immutable_v4_evidence_conflict:' + key)
  }
}

if (!CONFIRM) {
  console.log(JSON.stringify({
    status: 'dry_run',
    production_effect: false,
    source_sha: sourceSha,
    evidence_artifact_id: evidenceArtifactId,
    artifact_checksum: artifactChecksum,
    dates,
    rows: rows.length,
    existing_rows: existing.length,
    missing_rows: rows.length - existing.length,
  }, null, 2))
  process.exit(0)
}

const existingKeys = new Set(existing.map((row) =>
  [row.route_version, row.signal_date, String(row.symbol).toUpperCase(), row.producer_run_id].join('|'),
))
const missing = rows.filter((row) =>
  !existingKeys.has([row.route_version, row.signal_date, row.symbol, row.producer_run_id].join('|')),
)
for (let offset = 0; offset < missing.length; offset += 60) {
  const values = missing.slice(offset, offset + 60).map((row) => '(' + [
    sqlText(row.route_version),
    sqlText(row.signal_date),
    sqlText(row.symbol),
    sqlText(row.producer_run_id),
    row.route_score,
    sqlText(row.incumbent_route_version),
    row.incumbent_route_score == null ? 'NULL' : row.incumbent_route_score,
    sqlText(row.strategy_spec_version),
    sqlText(row.evidence_method),
    sqlText(row.source_reference_contract),
    sqlText(row.evidence_artifact_id),
    sqlText(row.source_sha),
    sqlText(row.row_checksum),
    sqlText(row.artifact_checksum),
    '0',
  ].join(',') + ')').join(',')
  execute(
    'INSERT OR IGNORE INTO strategy_route_versioned_evidence_v1 ('
    + 'route_version,signal_date,symbol,producer_run_id,route_score,incumbent_route_version,'
    + 'incumbent_route_score,strategy_spec_version,evidence_method,source_reference_contract,'
    + 'evidence_artifact_id,source_sha,row_checksum,artifact_checksum,production_effect'
    + ') VALUES ' + values,
  )
}

const readback = execute(
  'SELECT route_version,signal_date,symbol,producer_run_id,row_checksum,artifact_checksum,production_effect '
  + 'FROM strategy_route_versioned_evidence_v1 WHERE route_version=' + sqlText(ROUTE_VERSION)
  + ' AND signal_date IN (' + dates.map(sqlText).join(',') + ') ORDER BY signal_date,symbol,producer_run_id',
).results ?? []
if (readback.length !== rows.length) throw new Error('v4_evidence_readback_count_mismatch:' + readback.length + ':' + rows.length)
for (const row of readback) {
  const key = [row.route_version, row.signal_date, String(row.symbol).toUpperCase(), row.producer_run_id].join('|')
  const expected = expectedByKey.get(key)
  if (!expected || row.row_checksum !== expected.row_checksum || row.artifact_checksum !== artifactChecksum || Number(row.production_effect) !== 0) {
    throw new Error('v4_evidence_readback_mismatch:' + key)
  }
}
console.log(JSON.stringify({
  status: 'materialized',
  production_effect: false,
  source_sha: sourceSha,
  evidence_artifact_id: evidenceArtifactId,
  artifact_checksum: artifactChecksum,
  dates,
  rows: rows.length,
  inserted_rows: missing.length,
  readback_rows: readback.length,
}, null, 2))
