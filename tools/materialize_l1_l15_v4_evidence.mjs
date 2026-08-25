import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB = 'stockvision-learning-db'
const ROUTE_VERSION = flag('--route-version', 'strategy-semantic-continuous-affinity-v4')
const INPUT = flag('--input', join('output', 'l1_l15_route_repair_comparison', 'semantic_v4_evidence_rows.json'))
const WRANGLER = join('worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const CONFIRM = process.argv.includes('--confirm-production-effect-none')

if (!new Set([
  'strategy-semantic-continuous-affinity-v4',
  'strategy-semantic-continuous-affinity-v5',
]).has(ROUTE_VERSION)) throw new Error('unsupported_route_version:' + ROUTE_VERSION)

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
if (!Array.isArray(inputRows) || inputRows.length === 0) throw new Error('route_evidence_rows_empty')
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
const storedSelect = 'SELECT route_version,signal_date,symbol,producer_run_id,route_score,incumbent_route_version,'
  + 'incumbent_route_score,strategy_spec_version,evidence_method,source_reference_contract,'
  + 'evidence_artifact_id,source_sha,row_checksum,artifact_checksum,production_effect '
const existing = execute(
  storedSelect
  + 'FROM strategy_route_versioned_evidence_v1 WHERE route_version=' + sqlText(ROUTE_VERSION)
  + ' AND signal_date IN (' + dates.map(sqlText).join(',') + ') ORDER BY signal_date,symbol,producer_run_id',
).results ?? []
const expectedCoreByKey = new Map(coreRows.map((row) => [
  [row.route_version, row.signal_date, row.symbol, row.producer_run_id].join('|'), row,
]))

function storedCore(row) {
  return {
    route_version: String(row.route_version),
    signal_date: String(row.signal_date),
    symbol: String(row.symbol).trim().toUpperCase(),
    producer_run_id: String(row.producer_run_id),
    route_score: Number(row.route_score),
    incumbent_route_version: String(row.incumbent_route_version),
    incumbent_route_score: row.incumbent_route_score == null ? null : Number(row.incumbent_route_score),
    strategy_spec_version: String(row.strategy_spec_version),
    evidence_method: String(row.evidence_method),
    source_reference_contract: String(row.source_reference_contract),
  }
}

function validateStoredRows(storedRows, phase) {
  const artifactGroups = new Map()
  for (const stored of storedRows) {
    const core = storedCore(stored)
    const key = [core.route_version, core.signal_date, core.symbol, core.producer_run_id].join('|')
    const expected = expectedCoreByKey.get(key)
    if (!expected || JSON.stringify(core) !== JSON.stringify(expected) || Number(stored.production_effect) !== 0) {
      throw new Error('immutable_route_evidence_conflict:' + phase + ':' + key)
    }
    const rowAttestation = sha256(JSON.stringify({
      ...core,
      evidence_artifact_id: String(stored.evidence_artifact_id),
      source_sha: String(stored.source_sha),
    }))
    if (String(stored.row_checksum) !== rowAttestation) {
      throw new Error('immutable_route_row_checksum_mismatch:' + phase + ':' + key)
    }
    const artifactId = String(stored.evidence_artifact_id)
    const artifactChecksum = String(stored.artifact_checksum)
    const group = artifactGroups.get(artifactId) ?? { checksum: artifactChecksum, rows: [] }
    if (group.checksum !== artifactChecksum) throw new Error('immutable_route_artifact_checksum_split:' + artifactId)
    group.rows.push(core)
    artifactGroups.set(artifactId, group)
  }
  for (const [artifactId, group] of artifactGroups) {
    group.rows.sort((left, right) =>
      left.signal_date.localeCompare(right.signal_date)
      || left.symbol.localeCompare(right.symbol)
      || left.producer_run_id.localeCompare(right.producer_run_id)
    )
    if (sha256(JSON.stringify(group.rows)) !== group.checksum) {
      throw new Error('immutable_route_artifact_checksum_mismatch:' + phase + ':' + artifactId)
    }
  }
}

validateStoredRows(existing, 'existing')
const existingKeys = new Set(existing.map((row) =>
  [row.route_version, row.signal_date, String(row.symbol).toUpperCase(), row.producer_run_id].join('|'),
))
const missingCoreRows = coreRows.filter((row) =>
  !existingKeys.has([row.route_version, row.signal_date, row.symbol, row.producer_run_id].join('|')),
)
const artifactChecksum = missingCoreRows.length ? sha256(JSON.stringify(missingCoreRows)) : null
const evidenceArtifactId = artifactChecksum
  ? 'strategy-route-evidence-' + ROUTE_VERSION.split('-').at(-1) + '-extension-' + artifactChecksum.slice(0, 24)
  : null
const insertRows = missingCoreRows.map((row) => ({
  ...row,
  evidence_artifact_id: evidenceArtifactId,
  source_sha: sourceSha,
  row_checksum: sha256(JSON.stringify({ ...row, evidence_artifact_id: evidenceArtifactId, source_sha: sourceSha })),
  artifact_checksum: artifactChecksum,
  production_effect: 0,
}))
if (!CONFIRM) {
  console.log(JSON.stringify({
    status: 'dry_run',
    production_effect: false,
    source_sha: sourceSha,
    evidence_artifact_id: evidenceArtifactId,
    artifact_checksum: artifactChecksum,
    dates,
    rows: coreRows.length,
    existing_rows: existing.length,
    missing_rows: insertRows.length,
  }, null, 2))
  process.exit(0)
}

for (let offset = 0; offset < insertRows.length; offset += 60) {
  const values = insertRows.slice(offset, offset + 60).map((row) => '(' + [
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
  storedSelect
  + 'FROM strategy_route_versioned_evidence_v1 WHERE route_version=' + sqlText(ROUTE_VERSION)
  + ' AND signal_date IN (' + dates.map(sqlText).join(',') + ') ORDER BY signal_date,symbol,producer_run_id',
).results ?? []
if (readback.length !== coreRows.length) throw new Error('route_evidence_readback_count_mismatch:' + readback.length + ':' + coreRows.length)
validateStoredRows(readback, 'readback')
console.log(JSON.stringify({
  status: 'materialized',
  production_effect: false,
  source_sha: sourceSha,
  evidence_artifact_id: evidenceArtifactId,
  artifact_checksum: artifactChecksum,
  dates,
  rows: coreRows.length,
  inserted_rows: insertRows.length,
  readback_rows: readback.length,
}, null, 2))
