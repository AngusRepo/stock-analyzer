import {
  DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
  isExpectedReturnSemanticControlTable,
} from './dataDomainShadowManifest'
import {
  EXPECTED_RETURN_POINTER_OWNERS,
  expectedReturnArtifactLinkBlockers,
  expectedReturnHistoryEvidenceBlockers,
  type ExpectedReturnHistoryRow,
  type ExpectedReturnPayloadRow,
  type ExpectedReturnRegistryRow,
} from './expectedReturnPointerSemanticGuard'

type Row = Record<string, unknown>

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid_sql_identifier:${value}`)
  }
  return `"${value}"`
}

async function loadRowsByArtifactIds<T extends Row>(
  db: D1Database,
  table: 'model_artifact_registry' | 'expected_return_artifact_payloads',
  columns: readonly string[],
  artifactIds: readonly string[],
): Promise<T[]> {
  const ids = [...new Set(artifactIds.map((value) => value.trim()).filter(Boolean))]
  if (!ids.length) return []
  if (ids.length > 25) throw new Error(`expected_return_semantic_ref_page_too_large:${ids.length}`)
  const result = await db.prepare(`
    SELECT ${columns.map(identifier).join(', ')}
      FROM ${identifier(table)}
     WHERE artifact_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY artifact_id
     LIMIT 25
  `).bind(...ids).all<T>()
  return result.results ?? []
}

const REGISTRY_COLUMNS = [
  'artifact_id', 'model_name', 'version', 'state', 'artifact_path',
  'training_run_id', 'feature_policy_version', 'checksum', 'offline_evidence_json',
] as const

const PAYLOAD_COLUMNS = [
  'artifact_id', 'model_name', 'model_version', 'serving_mode', 'artifact_json',
  'payload_checksum', 'source_artifact_path', 'source_artifact_checksum', 'source_cohort_id',
] as const

export type ExpectedReturnControlSemanticPageResult = {
  schemaVersion: typeof DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION
  rowsScanned: number
  rowsApplicable: number
  rowsValidated: number
}

export async function validateExpectedReturnControlSemanticPage(
  db: D1Database,
  table: string,
  rows: readonly Row[],
): Promise<ExpectedReturnControlSemanticPageResult> {
  if (!isExpectedReturnSemanticControlTable(table)) {
    return {
      schemaVersion: DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
      rowsScanned: rows.length,
      rowsApplicable: 0,
      rowsValidated: 0,
    }
  }
  const expectedOwners = new Set<string>(EXPECTED_RETURN_POINTER_OWNERS)
  const blockers: string[] = []
  let rowsApplicable = 0
  if (table === 'expected_return_artifact_payloads') {
    const payloads = rows as ExpectedReturnPayloadRow[]
    rowsApplicable = payloads.length
    const registry = await loadRowsByArtifactIds<ExpectedReturnRegistryRow>(
      db,
      'model_artifact_registry',
      REGISTRY_COLUMNS,
      payloads.map((row) => String(row.artifact_id ?? '')),
    )
    const registryById = new Map(registry.map((row) => [row.artifact_id, row]))
    for (const payload of payloads) {
      const linked = registryById.get(payload.artifact_id)
      if (!linked) {
        blockers.push(`payload:${payload.artifact_id}:registry_missing`)
        continue
      }
      blockers.push(...await expectedReturnArtifactLinkBlockers({
        registry: linked,
        payload,
        requireProduction: false,
        label: `payload:${payload.artifact_id}`,
      }))
    }
  } else {
    const historyRows = rows as ExpectedReturnHistoryRow[]
    const artifactIds = historyRows.map((row) => String(row.artifact_id ?? ''))
    const registry = await loadRowsByArtifactIds<ExpectedReturnRegistryRow>(
      db,
      'model_artifact_registry',
      REGISTRY_COLUMNS,
      artifactIds,
    )
    const payloads = await loadRowsByArtifactIds<ExpectedReturnPayloadRow>(
      db,
      'expected_return_artifact_payloads',
      PAYLOAD_COLUMNS,
      artifactIds,
    )
    const registryById = new Map(registry.map((row) => [row.artifact_id, row]))
    const payloadById = new Map(payloads.map((row) => [row.artifact_id, row]))
    for (const row of historyRows) {
      const linkedRegistry = registryById.get(row.artifact_id)
      const linkedPayload = payloadById.get(row.artifact_id)
      const applicable = expectedOwners.has(String(row.model_name ?? ''))
        || expectedOwners.has(String(linkedRegistry?.model_name ?? ''))
        || expectedOwners.has(String(linkedPayload?.model_name ?? ''))
      if (!applicable) continue
      rowsApplicable += 1
      if (!linkedRegistry) blockers.push(`history:${row.event_id}:registry_missing`)
      if (!linkedPayload) blockers.push(`history:${row.event_id}:payload_missing`)
      if (!linkedRegistry || !linkedPayload) continue
      if (linkedRegistry.model_name !== row.model_name) {
        blockers.push(`history:${row.event_id}:registry_owner`)
      }
      if (linkedRegistry.version !== row.version) {
        blockers.push(`history:${row.event_id}:registry_version`)
      }
      blockers.push(...expectedReturnHistoryEvidenceBlockers({
        row,
        registry: linkedRegistry,
        payload: linkedPayload,
      }))
      blockers.push(...await expectedReturnArtifactLinkBlockers({
        registry: linkedRegistry,
        payload: linkedPayload,
        requireProduction: false,
        label: `history:${row.event_id}:payload`,
      }))
    }
  }
  if (blockers.length) {
    throw new Error(`expected_return_control_semantic_invalid:${[
      ...new Set(blockers),
    ].join('|')}`)
  }
  return {
    schemaVersion: DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
    rowsScanned: rows.length,
    rowsApplicable,
    rowsValidated: rowsApplicable,
  }
}
