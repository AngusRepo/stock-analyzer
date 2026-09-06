import type { Bindings } from '../types'
import { databaseForTable } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'
import { LegacyEvidenceResolveError, resolveLegacyScreenerEvidence, type ResolvedLegacyEvidenceRow } from './legacyEvidenceResolver'

export const AUDIT_POINTER_SCHEMA = 'd1-audit-json-pointer-v1'
const KIND = 'd1_audit_json_archive'
const SCHEMA = 'd1-audit-json-archive-v1'
const TARGETS = ['screener_funnel_items', 'canonical_screener_funnel_items']

function fail(reason: string, status = 409): never {
  throw new LegacyEvidenceResolveError(`audit_evidence_${reason}`, status)
}

async function resolveAuditArchive(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  request: Record<string, any>,
): Promise<ResolvedLegacyEvidenceRow[]> {
  const id = String(request.snapshot_id ?? '')
  const key = String(request.r2_key ?? '')
  const checksum = String(request.checksum ?? '').toLowerCase()
  const sourceRun = String(request.source_run_id ?? '')
  const target = TARGETS.find(value => id.startsWith(`${KIND}:${value}:`)
    && key.startsWith(`archives/${KIND}/target=${value}/`))
  if (!target || id.length > 1024 || key.length > 2048 || request.artifact_id !== id
    || !/^sha256:[a-f0-9]{64}$/.test(checksum) || !sourceRun || sourceRun.length > 500) {
    fail('pointer_invalid', 400)
  }
  const db = databaseForTable(env, 'dataset_snapshots')
  const manifest = await db.prepare(`
    SELECT snapshot_id, kind, schema_version, status, primary_store, r2_key,
           checksum, row_count, metadata_json
      FROM dataset_snapshots WHERE snapshot_id=? LIMIT 1
  `).bind(id).first<Record<string, any>>()
  if (!manifest) fail('manifest_missing')
  if (manifest.kind !== KIND || manifest.schema_version !== SCHEMA || manifest.status !== 'ready'
    || manifest.primary_store !== 'r2' || manifest.r2_key !== key
    || String(manifest.checksum).toLowerCase() !== checksum) fail('manifest_mismatch')
  let metadata: any
  try { metadata = JSON.parse(manifest.metadata_json ?? '{}') } catch { fail('manifest_json_invalid') }
  if (metadata.table !== 'screener_funnel_items' || metadata.target !== target
    || metadata.key_column !== 'id' || !Array.isArray(metadata.blob_columns)
    || !metadata.blob_columns.includes('evidence')) fail('manifest_identity_mismatch')
  const object = await env.ARTIFACTS?.get(key)
  if (!object) fail('payload_missing')
  const body = await object.text()
  if ((await sha256Text(body)).toLowerCase() !== checksum) fail('checksum_mismatch')
  let archive: any
  try { archive = JSON.parse(body) } catch { fail('payload_json_invalid') }
  if (archive.schema_version !== SCHEMA || archive.archive_kind !== KIND || archive.target !== target
    || archive.table !== 'screener_funnel_items' || archive.key_column !== 'id'
    || !Array.isArray(archive.blob_columns) || !archive.blob_columns.includes('evidence') || !Array.isArray(archive.rows)
    || archive.rows.length !== Number(manifest.row_count) || archive.row_count !== archive.rows.length) {
    fail('payload_contract_mismatch')
  }
  const byId = new Map<number, Record<string, any>>()
  for (const row of archive.rows) {
    const rowId = Number(row?.id)
    if (!Number.isSafeInteger(rowId) || rowId <= 0 || byId.has(rowId)) fail('duplicate_or_invalid_row')
    byId.set(rowId, row)
  }
  return request.row_ids.map((rowId: number) => {
    const row = byId.get(rowId)
    if (!row || row.run_id !== sourceRun || row.stage !== 'scoring'
      || typeof row.symbol !== 'string' || !row.symbol.trim()
      || typeof row.evidence !== 'string' || !row.evidence.trim()) fail(`row_identity_mismatch:${rowId}`)
    let evidence: any
    try { evidence = JSON.parse(row.evidence) } catch { fail(`row_json_invalid:${rowId}`) }
    // Never recursively follow pointers or return another archived placeholder.
    if (!evidence?.score_components || evidence.schema_version === AUDIT_POINTER_SCHEMA) fail(`row_payload_missing:${rowId}`)
    return { row_id: rowId, symbol: row.symbol.trim(), stage: row.stage, evidence: row.evidence,
      source_run_id: sourceRun, artifact_id: id, r2_key: key, checksum }
  })
}

/** Same authenticated read API, both retention formats; all-or-error coverage. */
export async function resolveScreenerEvidence(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  raw: unknown,
): Promise<{ rows: ResolvedLegacyEvidenceRow[]; artifacts: number }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) fail('artifact_limit', 400)
  const ids = new Set<number>()
  for (const request of raw) {
    if (!Array.isArray(request?.row_ids) || !request.row_ids.length) fail('row_ids_missing', 400)
    for (const id of request.row_ids) {
      if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) fail('row_ids_invalid', 400)
      ids.add(id)
    }
  }
  if (ids.size > 400) fail('row_limit', 400)
  const rows: ResolvedLegacyEvidenceRow[] = []
  for (const request of raw) {
    if (request.schema_version === AUDIT_POINTER_SCHEMA) rows.push(...await resolveAuditArchive(env, request))
    else if (!request.schema_version || request.schema_version === 'legacy-screener-evidence-pointer-v1') {
      rows.push(...(await resolveLegacyScreenerEvidence(env, [request])).rows)
    } else fail('pointer_schema_unsupported', 400)
  }
  return { rows: rows.sort((a, b) => a.row_id - b.row_id), artifacts: raw.length }
}
