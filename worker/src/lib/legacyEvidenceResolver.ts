import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'

const POINTER_SCHEMA = 'legacy-screener-evidence-pointer-v1'
const ARCHIVE_SCHEMA = 'legacy-screener-funnel-evidence-v1'
const ARCHIVE_DOMAIN = 'legacy_screener_funnel_evidence'
const ARCHIVE_KEY_PREFIX = 'evidence/class=superseded_run/domain=legacy_screener_funnel_evidence/'
const MAX_ARTIFACTS = 4
const MAX_ROW_IDS = 400

type RawResolveRequest = {
  artifact_id?: unknown
  r2_key?: unknown
  checksum?: unknown
  source_run_id?: unknown
  row_ids?: unknown
}

type ResolveRequest = {
  artifact_id: string
  r2_key: string
  checksum: string
  source_run_id: string
  row_ids: number[]
}

type ArtifactManifestRow = {
  artifact_id: string
  status: string
  domain: string
  producer_run_id: string
  r2_key: string
  checksum: string
  schema_version: string
  payload_deleted_at: string | null
}

export type ResolvedLegacyEvidenceRow = {
  row_id: number
  symbol: string
  stage: string
  evidence: string
  source_run_id: string
  artifact_id: string
  r2_key: string
  checksum: string
}

export class LegacyEvidenceResolveError extends Error {
  constructor(message: string, public readonly statusCode = 409) {
    super(message)
  }
}

function requiredText(value: unknown, field: string, maxLength = 500): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maxLength) {
    throw new LegacyEvidenceResolveError(`invalid_${field}`, 400)
  }
  return text
}

function parseRequests(raw: unknown): ResolveRequest[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ARTIFACTS) {
    throw new LegacyEvidenceResolveError(`artifacts_must_have_1_to_${MAX_ARTIFACTS}_items`, 400)
  }
  let totalRows = 0
  const seenRows = new Set<number>()
  return raw.map((value, index) => {
    const item = (value ?? {}) as RawResolveRequest
    const artifactId = requiredText(item.artifact_id, `artifact_id_${index}`)
    const r2Key = requiredText(item.r2_key, `r2_key_${index}`, 1024)
    const checksum = requiredText(item.checksum, `checksum_${index}`).toLowerCase()
    const sourceRunId = requiredText(item.source_run_id, `source_run_id_${index}`)
    if (!artifactId.startsWith(`artifact:${ARCHIVE_DOMAIN}:`)) {
      throw new LegacyEvidenceResolveError(`artifact_domain_mismatch:${artifactId}`, 400)
    }
    if (!r2Key.startsWith(ARCHIVE_KEY_PREFIX)) {
      throw new LegacyEvidenceResolveError(`artifact_r2_key_domain_mismatch:${artifactId}`, 400)
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(checksum)) {
      throw new LegacyEvidenceResolveError(`artifact_checksum_invalid:${artifactId}`, 400)
    }
    if (!Array.isArray(item.row_ids) || !item.row_ids.length) {
      throw new LegacyEvidenceResolveError(`artifact_row_ids_missing:${artifactId}`, 400)
    }
    const rowIds = item.row_ids.map((rowId) => Number(rowId))
    if (rowIds.some((rowId) => !Number.isSafeInteger(rowId) || rowId <= 0)) {
      throw new LegacyEvidenceResolveError(`artifact_row_id_invalid:${artifactId}`, 400)
    }
    for (const rowId of rowIds) {
      if (seenRows.has(rowId)) {
        throw new LegacyEvidenceResolveError(`artifact_row_id_duplicate:${rowId}`, 400)
      }
      seenRows.add(rowId)
    }
    totalRows += rowIds.length
    if (totalRows > MAX_ROW_IDS) {
      throw new LegacyEvidenceResolveError(`artifact_row_limit_exceeded:${MAX_ROW_IDS}`, 400)
    }
    return {
      artifact_id: artifactId,
      r2_key: r2Key,
      checksum,
      source_run_id: sourceRunId,
      row_ids: rowIds,
    }
  })
}

export async function resolveLegacyScreenerEvidence(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  rawRequests: unknown,
): Promise<{ rows: ResolvedLegacyEvidenceRow[]; artifacts: number }> {
  if (!env.ARTIFACTS) throw new LegacyEvidenceResolveError('artifact_r2_binding_missing', 503)
  const requests = parseRequests(rawRequests)
  const opsDb = databaseForDataDomain(env, 'ops')
  const manifestResults = await opsDb.batch(requests.map((request) => opsDb.prepare(`
    SELECT artifact_id, status, domain, producer_run_id, r2_key, checksum,
           schema_version, payload_deleted_at
      FROM run_artifacts
     WHERE artifact_id=?
     LIMIT 1
  `).bind(request.artifact_id)))

  const resolvedRows: ResolvedLegacyEvidenceRow[] = []
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]
    const manifest = ((manifestResults[index] as any)?.results ?? [])[0] as ArtifactManifestRow | undefined
    if (!manifest) {
      throw new LegacyEvidenceResolveError(`artifact_manifest_missing:${request.artifact_id}`)
    }
    if (
      manifest.status !== 'ready'
      || manifest.domain !== ARCHIVE_DOMAIN
      || manifest.schema_version !== ARCHIVE_SCHEMA
      || manifest.payload_deleted_at != null
      || manifest.r2_key !== request.r2_key
      || String(manifest.checksum).toLowerCase() !== request.checksum
    ) {
      throw new LegacyEvidenceResolveError(`artifact_manifest_mismatch:${request.artifact_id}`)
    }

    const object = await (env.ARTIFACTS as any).get(request.r2_key)
    if (!object) throw new LegacyEvidenceResolveError(`artifact_payload_missing:${request.artifact_id}`)
    const body = await object.text()
    if ((await sha256Text(body)).toLowerCase() !== request.checksum) {
      throw new LegacyEvidenceResolveError(`artifact_payload_checksum_mismatch:${request.artifact_id}`)
    }

    let archive: any
    try {
      archive = JSON.parse(body)
    } catch {
      throw new LegacyEvidenceResolveError(`artifact_payload_json_invalid:${request.artifact_id}`)
    }
    const payload = archive?.payload
    if (
      archive?.schema_version !== ARCHIVE_SCHEMA
      || archive?.domain !== ARCHIVE_DOMAIN
      || payload?.source_run_id !== request.source_run_id
      || !Array.isArray(payload?.rows)
    ) {
      throw new LegacyEvidenceResolveError(`artifact_payload_contract_mismatch:${request.artifact_id}`)
    }

    const archivedById = new Map<number, any>()
    for (const row of payload.rows) {
      const rowId = Number(row?.id)
      if (Number.isSafeInteger(rowId) && rowId > 0) archivedById.set(rowId, row)
    }
    for (const rowId of request.row_ids) {
      const archived = archivedById.get(rowId)
      if (
        !archived
        || archived.stage !== 'scoring'
        || typeof archived.symbol !== 'string'
        || !archived.symbol.trim()
        || typeof archived.evidence !== 'string'
        || !archived.evidence.trim()
      ) {
        throw new LegacyEvidenceResolveError(`artifact_row_contract_mismatch:${rowId}`)
      }
      resolvedRows.push({
        row_id: rowId,
        symbol: archived.symbol.trim(),
        stage: archived.stage,
        evidence: archived.evidence,
        source_run_id: request.source_run_id,
        artifact_id: request.artifact_id,
        r2_key: request.r2_key,
        checksum: request.checksum,
      })
    }
  }

  return { rows: resolvedRows.sort((left, right) => left.row_id - right.row_id), artifacts: requests.length }
}

export const LEGACY_EVIDENCE_POINTER_SCHEMA = POINTER_SCHEMA
