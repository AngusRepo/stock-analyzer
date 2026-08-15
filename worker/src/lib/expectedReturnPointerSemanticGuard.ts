import { loadDataDomainControlRevision } from './dataDomainControlRevision'
import { checksumText, type DataDomainControlTable } from './dataDomainShadowManifest'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'

export const EXPECTED_RETURN_POINTER_OWNERS = ['l4_alpha_ev', 'allocator_ev_fusion'] as const

export type ExpectedReturnPointerRow = {
  model_name: string
  champion_version: string
  champion_artifact_id: string
  rollback_version: string | null
  rollback_artifact_id: string | null
  promoted_at: string
  promotion_reason: string
  promotion_evidence_json: string
}

export type ExpectedReturnRegistryRow = {
  artifact_id: string
  model_name: string
  version: string
  state: string
  artifact_path: string
  training_run_id: string
  feature_policy_version: string
  checksum: string
  offline_evidence_json: string | null
}

export type ExpectedReturnPayloadRow = {
  artifact_id: string
  model_name: string
  model_version: string
  serving_mode: string
  artifact_json: string
  payload_checksum: string
  source_artifact_path: string
  source_artifact_checksum: string
  source_cohort_id: string
}

export type ExpectedReturnHistoryRow = {
  event_id: string
  model_name: string
  version: string
  artifact_id: string
  effective_at: string
  retired_at: string | null
  source: string
  evidence_grade: string
  evidence_json: string
}

type HistoryIntervalSummary = {
  model_name: string
  total_rows: number | string
  open_rows: number | string
  invalid_intervals: number | string
  unresolved_registry_rows: number | string
  unresolved_payload_rows: number | string
  identity_mismatch_rows: number | string
  invalid_evidence_rows?: number | string
}

type HistoryIntervalPageSummary = Omit<HistoryIntervalSummary, 'model_name'> & {
  null_event_id_rows: number | string
  page_has_more: number | string
  page_last_effective_at: string | null
  page_last_event_id: string | null
}

export const EXPECTED_RETURN_HISTORY_PAGE_SIZE = 250
export const EXPECTED_RETURN_HISTORY_MAX_PAGES_PER_OWNER = 100
export const EXPECTED_RETURN_HISTORY_MAX_ROWS_PER_OWNER =
  EXPECTED_RETURN_HISTORY_PAGE_SIZE * EXPECTED_RETURN_HISTORY_MAX_PAGES_PER_OWNER
const EXPECTED_RETURN_SEMANTIC_REVISION_TABLES = [
  'model_artifact_registry',
  'expected_return_artifact_payloads',
  'model_champion_history',
  'model_champion_pointers',
] as const satisfies readonly DataDomainControlTable[]
const EXPECTED_RETURN_SEMANTIC_BASE_MAX_SQL_STATEMENTS = 4
const EXPECTED_RETURN_SEMANTIC_REVISION_SQL_STATEMENTS =
  EXPECTED_RETURN_SEMANTIC_REVISION_TABLES.length * 2
export const EXPECTED_RETURN_SEMANTIC_SNAPSHOT_MAX_SQL_STATEMENTS =
  EXPECTED_RETURN_SEMANTIC_BASE_MAX_SQL_STATEMENTS
  + EXPECTED_RETURN_SEMANTIC_REVISION_SQL_STATEMENTS
  + EXPECTED_RETURN_POINTER_OWNERS.length * EXPECTED_RETURN_HISTORY_MAX_PAGES_PER_OWNER
export const EXPECTED_RETURN_POINTER_GUARD_MAX_SEMANTIC_SNAPSHOTS_PER_INVOCATION = 4
export const EXPECTED_RETURN_POINTER_GUARD_MAX_SEMANTIC_SQL_STATEMENTS =
  EXPECTED_RETURN_SEMANTIC_SNAPSHOT_MAX_SQL_STATEMENTS
  * EXPECTED_RETURN_POINTER_GUARD_MAX_SEMANTIC_SNAPSHOTS_PER_INVOCATION

export type ExpectedReturnSemanticSnapshot = {
  pointers: ExpectedReturnPointerRow[]
  registry: ExpectedReturnRegistryRow[]
  payloads: ExpectedReturnPayloadRow[]
  history: ExpectedReturnHistoryRow[]
  intervals: HistoryIntervalSummary[]
  componentDigests: Record<
    'model_champion_pointers'
    | 'model_artifact_registry'
    | 'expected_return_artifact_payloads'
    | 'model_champion_history',
    string
  >
  digest: string
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  try {
    return objectValue(JSON.parse(value))
  } catch {
    return null
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function timestampMs(value: unknown): number {
  const raw = String(value ?? '').trim()
  if (!raw) return Number.NaN
  const iso = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(raw)
    ? raw
    : `${raw.replace(' ', 'T')}Z`
  return Date.parse(iso)
}

function sameInstant(left: unknown, right: unknown): boolean {
  const leftMs = timestampMs(left)
  const rightMs = timestampMs(right)
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs
}

async function rowsDigest(rows: readonly unknown[]): Promise<string> {
  return checksumText(JSON.stringify(rows))
}

function exactNonNegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`expected_return_pointer_shadow_guard_history_summary_invalid:${label}:${String(value)}`)
  }
  return parsed
}

async function loadExpectedReturnSemanticRevisionVector(
  db: D1Database,
): Promise<Record<DataDomainControlTable, number>> {
  return Object.fromEntries(await Promise.all(
    EXPECTED_RETURN_SEMANTIC_REVISION_TABLES.map(async (table) => [
      table,
      await loadDataDomainControlRevision(db, table),
    ] as const),
  )) as Record<DataDomainControlTable, number>
}

function assertExpectedReturnSemanticRevisionStable(
  before: Readonly<Record<DataDomainControlTable, number>>,
  after: Readonly<Record<DataDomainControlTable, number>>,
): void {
  const changed = EXPECTED_RETURN_SEMANTIC_REVISION_TABLES.filter(
    (table) => before[table] !== after[table],
  )
  if (changed.length) {
    throw new Error(`expected_return_pointer_shadow_guard_semantic_snapshot_revision_drift:${changed
      .map((table) => `${table}:${before[table]}/${after[table]}`)
      .join('|')}`)
  }
}

export async function loadExpectedReturnHistoryIntervalSummaries(
  db: D1Database,
): Promise<HistoryIntervalSummary[]> {
  const intervals: HistoryIntervalSummary[] = []
  for (const owner of EXPECTED_RETURN_POINTER_OWNERS) {
    let cursor: { effectiveAt: string; eventId: string } | null = null
    let summary: HistoryIntervalSummary | null = null
    let completed = false
    for (let pageNumber = 0; pageNumber < EXPECTED_RETURN_HISTORY_MAX_PAGES_PER_OWNER; pageNumber += 1) {
      const cursorSql = cursor
        ? `AND (
             h.effective_at > ?
             OR (h.effective_at = ? AND h.event_id > ?)
           )`
        : ''
      const cursorBinds = cursor
        ? [cursor.effectiveAt, cursor.effectiveAt, cursor.eventId]
        : []
      const pageResult = await db.prepare(`
        WITH candidate AS (
          SELECT h.model_name, h.event_id, h.version, h.artifact_id,
                 h.effective_at, h.retired_at, h.source, h.evidence_grade, h.evidence_json,
                 (
                   SELECT next.effective_at
                     FROM model_champion_history next
                    WHERE next.model_name=h.model_name
                      AND (
                        next.effective_at > h.effective_at
                        OR (next.effective_at = h.effective_at AND next.event_id > h.event_id)
                      )
                    ORDER BY next.effective_at, next.event_id
                    LIMIT 1
                 ) AS next_effective,
                 r.artifact_id AS registry_artifact_id,
                 r.model_name AS registry_model_name,
                 r.version AS registry_version,
                 r.artifact_path AS registry_artifact_path,
                 r.checksum AS registry_checksum,
                 p.artifact_id AS payload_artifact_id,
                 p.payload_checksum AS payload_checksum,
                 p.artifact_json AS payload_artifact_json,
                 CASE
                   WHEN json_valid(h.evidence_json) = 1 THEN h.evidence_json
                   ELSE '{}'
                 END AS safe_evidence_json,
                 CASE
                   WHEN json_valid(p.artifact_json) = 1 THEN p.artifact_json
                   ELSE '{}'
                 END AS safe_payload_artifact_json
            FROM model_champion_history h
            LEFT JOIN model_artifact_registry r ON r.artifact_id=h.artifact_id
            LEFT JOIN expected_return_artifact_payloads p ON p.artifact_id=h.artifact_id
           WHERE h.model_name=?
             ${cursorSql}
           ORDER BY h.effective_at, h.event_id
           LIMIT ?
        ), page AS (
          SELECT *
            FROM candidate
           ORDER BY effective_at, event_id
           LIMIT ?
        ), page_meta AS (
          SELECT effective_at AS last_effective_at, event_id AS last_event_id
            FROM page
           ORDER BY effective_at DESC, event_id DESC
           LIMIT 1
        )
        SELECT COUNT(*) AS total_rows,
               SUM(CASE WHEN event_id IS NULL THEN 1 ELSE 0 END) AS null_event_id_rows,
               SUM(CASE WHEN retired_at IS NULL THEN 1 ELSE 0 END) AS open_rows,
               SUM(CASE
                 WHEN julianday(effective_at) IS NULL THEN 1
                 WHEN next_effective IS NOT NULL AND (
                   julianday(next_effective) IS NULL
                   OR julianday(next_effective) <= julianday(effective_at)
                   OR retired_at IS NULL
                   OR julianday(retired_at) <> julianday(next_effective)
                 ) THEN 1
                 WHEN next_effective IS NULL AND retired_at IS NOT NULL THEN 1
                 ELSE 0
               END) AS invalid_intervals,
               SUM(CASE WHEN registry_artifact_id IS NULL THEN 1 ELSE 0 END)
                 AS unresolved_registry_rows,
               SUM(CASE WHEN payload_artifact_id IS NULL THEN 1 ELSE 0 END)
                 AS unresolved_payload_rows,
               SUM(CASE
                 WHEN registry_artifact_id IS NOT NULL
                  AND (registry_model_name <> model_name OR registry_version <> version)
                 THEN 1 ELSE 0 END) AS identity_mismatch_rows,
               SUM(CASE
                 WHEN source <> 'model_champion_history'
                   OR evidence_grade <> 'exact'
                   OR evidence_json IS NULL
                   OR json_valid(evidence_json) = 0
                   OR payload_artifact_json IS NULL
                   OR json_valid(payload_artifact_json) = 0
                   OR json_type(safe_evidence_json) <> 'object'
                   OR TRIM(COALESCE(json_extract(safe_evidence_json, '$.schema_version'), '')) = ''
                   OR (
                     json_type(safe_evidence_json, '$.owner') IS NOT NULL
                     AND json_extract(safe_evidence_json, '$.owner') <> model_name
                   )
                   OR (
                     json_type(safe_evidence_json, '$.version') IS NOT NULL
                     AND json_extract(safe_evidence_json, '$.version') <> version
                   )
                   OR (
                     json_type(safe_evidence_json, '$.model_version') IS NOT NULL
                     AND json_extract(safe_evidence_json, '$.model_version') <> version
                   )
                   OR (
                     json_type(safe_evidence_json, '$.artifact_path') IS NOT NULL
                     AND json_extract(safe_evidence_json, '$.artifact_path') <> registry_artifact_path
                   )
                   OR (
                     json_type(safe_evidence_json, '$.artifact_checksum') IS NOT NULL
                     AND json_extract(safe_evidence_json, '$.artifact_checksum') <> registry_checksum
                   )
                   OR (
                     json_type(safe_evidence_json, '$.payload_checksum') IS NOT NULL
                     AND json_extract(safe_evidence_json, '$.payload_checksum') <> payload_checksum
                   )
                   OR (
                     json_type(safe_evidence_json, '$.artifact_contract_version') IS NOT NULL
                     AND json_extract(safe_evidence_json, '$.artifact_contract_version')
                       <> json_extract(safe_payload_artifact_json, '$.artifact_contract_version')
                   )
                 THEN 1 ELSE 0 END) AS invalid_evidence_rows,
               CASE WHEN (SELECT COUNT(*) FROM candidate) > ? THEN 1 ELSE 0 END
                 AS page_has_more,
               (SELECT last_effective_at FROM page_meta) AS page_last_effective_at,
               (SELECT last_event_id FROM page_meta) AS page_last_event_id
          FROM page
      `).bind(
        owner,
        ...cursorBinds,
        EXPECTED_RETURN_HISTORY_PAGE_SIZE + 1,
        EXPECTED_RETURN_HISTORY_PAGE_SIZE,
        EXPECTED_RETURN_HISTORY_PAGE_SIZE,
      ).all<HistoryIntervalPageSummary>()
      const page = (pageResult.results ?? [])[0]
      const pageRows = page
        ? exactNonNegativeInteger(page.total_rows, `${owner}:page_rows`)
        : 0
      if (pageRows === 0) {
        completed = true
        break
      }
      if (pageRows > EXPECTED_RETURN_HISTORY_PAGE_SIZE) {
        throw new Error(`expected_return_pointer_shadow_guard_history_page_oversized:${owner}:${pageRows}`)
      }
      const nullEventIdRows = exactNonNegativeInteger(
        page.null_event_id_rows,
        `${owner}:null_event_id_rows`,
      )
      if (nullEventIdRows > 0) {
        throw new Error(`expected_return_pointer_shadow_guard_history_event_id_null:${owner}:${nullEventIdRows}`)
      }
      const add = (field: keyof Omit<HistoryIntervalSummary, 'model_name'>): number => (
        exactNonNegativeInteger(page[field], `${owner}:${String(field)}`)
      )
      summary = {
        model_name: owner,
        total_rows: Number(summary?.total_rows ?? 0) + add('total_rows'),
        open_rows: Number(summary?.open_rows ?? 0) + add('open_rows'),
        invalid_intervals: Number(summary?.invalid_intervals ?? 0) + add('invalid_intervals'),
        unresolved_registry_rows:
          Number(summary?.unresolved_registry_rows ?? 0) + add('unresolved_registry_rows'),
        unresolved_payload_rows:
          Number(summary?.unresolved_payload_rows ?? 0) + add('unresolved_payload_rows'),
        identity_mismatch_rows:
          Number(summary?.identity_mismatch_rows ?? 0) + add('identity_mismatch_rows'),
        invalid_evidence_rows:
          Number(summary?.invalid_evidence_rows ?? 0) + add('invalid_evidence_rows'),
      }
      const hasMore = exactNonNegativeInteger(page.page_has_more, `${owner}:page_has_more`)
      if (hasMore !== 0 && hasMore !== 1) {
        throw new Error(`expected_return_pointer_shadow_guard_history_has_more_invalid:${owner}:${hasMore}`)
      }
      if (!hasMore) {
        completed = true
        break
      }
      if (!page.page_last_effective_at || !page.page_last_event_id) {
        throw new Error(`expected_return_pointer_shadow_guard_history_cursor_missing:${owner}`)
      }
      if (
        cursor
        && cursor.effectiveAt === page.page_last_effective_at
        && cursor.eventId === page.page_last_event_id
      ) {
        throw new Error(`expected_return_pointer_shadow_guard_history_cursor_stalled:${owner}`)
      }
      cursor = {
        effectiveAt: page.page_last_effective_at,
        eventId: page.page_last_event_id,
      }
    }
    if (!completed) {
      throw new Error(
        `expected_return_pointer_shadow_guard_history_cap_exceeded:${owner}:${EXPECTED_RETURN_HISTORY_MAX_ROWS_PER_OWNER}`,
      )
    }
    if (summary) intervals.push(summary)
  }
  return intervals.sort((left, right) => left.model_name.localeCompare(right.model_name))
}

export async function loadExpectedReturnSemanticSnapshot(
  db: D1Database,
): Promise<ExpectedReturnSemanticSnapshot> {
  const revisionBefore = await loadExpectedReturnSemanticRevisionVector(db)
  const pointersResult = await db.prepare(`
    SELECT model_name, champion_version, champion_artifact_id,
           rollback_version, rollback_artifact_id, promoted_at,
           promotion_reason, promotion_evidence_json
      FROM model_champion_pointers
     WHERE model_name IN (?, ?)
     ORDER BY model_name
  `).bind(...EXPECTED_RETURN_POINTER_OWNERS).all<ExpectedReturnPointerRow>()
  const pointers = pointersResult.results ?? []
  const artifactIds = [...new Set(pointers.flatMap((row) => [
    row.champion_artifact_id,
    row.rollback_artifact_id ?? '',
  ]).filter(Boolean))]
  let registry: ExpectedReturnRegistryRow[] = []
  let payloads: ExpectedReturnPayloadRow[] = []
  let history: ExpectedReturnHistoryRow[] = []
  if (artifactIds.length) {
    const placeholders = artifactIds.map(() => '?').join(', ')
    const registryResult = await db.prepare(`
      SELECT artifact_id, model_name, version, state, artifact_path, training_run_id,
             feature_policy_version, checksum, offline_evidence_json
        FROM model_artifact_registry
       WHERE artifact_id IN (${placeholders})
       ORDER BY artifact_id
       LIMIT 25
    `).bind(...artifactIds).all<ExpectedReturnRegistryRow>()
    registry = registryResult.results ?? []
    const payloadResult = await db.prepare(`
      SELECT artifact_id, model_name, model_version, serving_mode, artifact_json,
             payload_checksum, source_artifact_path, source_artifact_checksum, source_cohort_id
        FROM expected_return_artifact_payloads
       WHERE artifact_id IN (${placeholders})
       ORDER BY artifact_id
       LIMIT 25
    `).bind(...artifactIds).all<ExpectedReturnPayloadRow>()
    payloads = payloadResult.results ?? []
    const historyReferences = pointers.flatMap((pointer) => [
      {
        modelName: pointer.model_name,
        version: pointer.champion_version,
        artifactId: pointer.champion_artifact_id,
        open: true,
      },
      ...(pointer.rollback_version && pointer.rollback_artifact_id ? [{
        modelName: pointer.model_name,
        version: pointer.rollback_version,
        artifactId: pointer.rollback_artifact_id,
        open: false,
      }] : []),
    ])
    if (historyReferences.length) {
      const historyResult = await db.prepare(`
        SELECT event_id, model_name, version, artifact_id, effective_at, retired_at,
               source, evidence_grade, evidence_json
          FROM model_champion_history
         WHERE ${historyReferences.map((reference) => `(
           model_name=? AND version=? AND artifact_id=?
           AND retired_at IS ${reference.open ? '' : 'NOT '}NULL
         )`).join(' OR ')}
         ORDER BY model_name, effective_at, event_id
         LIMIT 25
      `).bind(...historyReferences.flatMap((reference) => [
        reference.modelName,
        reference.version,
        reference.artifactId,
      ])).all<ExpectedReturnHistoryRow>()
      history = historyResult.results ?? []
    }
  }
  const intervals = await loadExpectedReturnHistoryIntervalSummaries(db)
  const revisionAfter = await loadExpectedReturnSemanticRevisionVector(db)
  assertExpectedReturnSemanticRevisionStable(revisionBefore, revisionAfter)
  const componentDigests = {
    model_champion_pointers: await rowsDigest(pointers),
    model_artifact_registry: await rowsDigest(registry),
    expected_return_artifact_payloads: await rowsDigest(payloads),
    model_champion_history: await rowsDigest([...history, ...intervals]),
  }
  return {
    pointers,
    registry,
    payloads,
    history,
    intervals,
    componentDigests,
    digest: await checksumText(JSON.stringify(componentDigests)),
  }
}

export async function expectedReturnArtifactLinkBlockers(input: {
  registry: ExpectedReturnRegistryRow
  payload: ExpectedReturnPayloadRow
  requireProduction: boolean
  label: string
}): Promise<string[]> {
  const { registry, payload, requireProduction, label } = input
  const blockers: string[] = []
  const push = (reason: string) => blockers.push(`${label}:${reason}`)
  if (payload.artifact_id !== registry.artifact_id) push('payload_artifact_id')
  if (payload.model_name !== registry.model_name) push('payload_owner')
  if (payload.model_version !== registry.version) push('payload_version')
  if (requireProduction && registry.state !== 'production') push(`registry_state:${registry.state}`)
  if (!nonEmpty(registry.artifact_path) || payload.source_artifact_path !== registry.artifact_path) {
    push('source_artifact_path')
  }
  if (!/^[a-f0-9]{64}$/.test(registry.checksum)
      || payload.source_artifact_checksum !== registry.checksum) {
    push('source_artifact_checksum')
  }
  const artifact = parseObject(payload.artifact_json)
  if (!artifact) return [...blockers, `${label}:artifact_json_invalid`]
  if (!/^[a-f0-9]{64}$/.test(payload.payload_checksum)
      || await checksumText(payload.artifact_json) !== payload.payload_checksum) {
    push('payload_raw_checksum')
  }
  if (artifact.expected_return_owner !== registry.model_name) push('artifact_owner')
  if (artifact.model_version !== registry.version) push('artifact_version')
  if (artifact.output_is_net_of_costs !== true) push('output_not_net_of_costs')
  const validation = objectValue(artifact.validation_packet)
  if (!validation || validation.decision !== 'PASS') push('validation_decision')
  if (
    validation?.failed_gates !== undefined
    && (!Array.isArray(validation.failed_gates) || validation.failed_gates.length !== 0)
  ) push('validation_failed_gates')
  if (!['alpha', 'abstention_baseline'].includes(payload.serving_mode)) {
    push(`serving_mode:${payload.serving_mode}`)
  }
  if (payload.serving_mode === 'abstention_baseline') {
    if (artifact.serving_mode !== 'abstention_baseline') push('artifact_serving_mode')
    if (artifact.promotion_state !== 'safe_abstention') push('promotion_state')
    if (validation?.alpha_quality_passed !== false) push('alpha_quality_passed')
    if (!nonEmpty(payload.source_cohort_id) || payload.source_cohort_id !== registry.training_run_id) {
      push('source_cohort')
    }
    if (artifact.artifact_contract_version !== registry.feature_policy_version) {
      push('artifact_contract_version')
    }
    if (payload.payload_checksum !== registry.checksum) push('baseline_registry_checksum')
    if (registry.model_name === 'allocator_ev_fusion'
        && artifact.primary_expected_return_allowed !== false) {
      push('fusion_primary_expected_return_allowed')
    }
  }
  if (payload.serving_mode === 'alpha') {
    if (artifact.serving_mode !== undefined && artifact.serving_mode !== 'alpha') {
      push('artifact_serving_mode')
    }
    const trainingData = objectValue(artifact.training_data)
    if (!nonEmpty(payload.source_cohort_id) || trainingData?.cohort_id !== payload.source_cohort_id) {
      push('source_cohort')
    }
    if (registry.training_run_id !== `active8_oof:${payload.source_cohort_id}`) {
      push('training_run_id')
    }
    if (artifact.feature_snapshot_version !== registry.feature_policy_version) {
      push('feature_snapshot_version')
    }
    const offlineEvidence = registry.offline_evidence_json
      ? parseObject(registry.offline_evidence_json)
      : null
    if (registry.offline_evidence_json && !offlineEvidence) push('offline_evidence_json')
    if (
      offlineEvidence?.artifact_contract_version !== undefined
      && artifact.artifact_contract_version !== offlineEvidence.artifact_contract_version
    ) push('artifact_contract_version')
    if (registry.model_name === 'l4_alpha_ev'
        && artifact.promotion_state !== 'production_approved') {
      push('promotion_state')
    }
    if (registry.model_name === 'allocator_ev_fusion') {
      if (artifact.promotion_state !== 'production_primary') push('promotion_state')
      if (artifact.primary_expected_return_allowed !== true) {
        push('fusion_primary_expected_return_allowed')
      }
      if (artifact.promotion_tier !== 'primary') push('promotion_tier')
      if (artifact.operational_parity_required !== false) push('operational_parity_required')
    }
  }
  return blockers
}

export function expectedReturnHistoryEvidenceBlockers(input: {
  row: ExpectedReturnHistoryRow
  registry: ExpectedReturnRegistryRow
  payload: ExpectedReturnPayloadRow
}): string[] {
  const { row, registry, payload } = input
  const prefix = `history:${row.event_id}`
  const blockers: string[] = []
  if (row.source !== 'model_champion_history') blockers.push(`${prefix}:source`)
  if (row.evidence_grade !== 'exact') blockers.push(`${prefix}:evidence_grade`)
  const evidence = parseObject(row.evidence_json)
  if (!evidence) return [...blockers, `${prefix}:evidence_json_invalid`]
  if (!nonEmpty(evidence.schema_version)) blockers.push(`${prefix}:schema_version`)
  if (evidence.owner !== undefined && evidence.owner !== row.model_name) blockers.push(`${prefix}:owner`)
  if (evidence.version !== undefined && evidence.version !== row.version) blockers.push(`${prefix}:version`)
  if (evidence.model_version !== undefined && evidence.model_version !== row.version) {
    blockers.push(`${prefix}:model_version`)
  }
  const artifact = parseObject(payload.artifact_json)
  if (
    evidence.artifact_contract_version !== undefined
    && evidence.artifact_contract_version !== artifact?.artifact_contract_version
  ) blockers.push(`${prefix}:artifact_contract_version`)
  if (evidence.artifact_checksum !== undefined && evidence.artifact_checksum !== registry.checksum) {
    blockers.push(`${prefix}:artifact_checksum`)
  }
  if (evidence.artifact_path !== undefined && evidence.artifact_path !== registry.artifact_path) {
    blockers.push(`${prefix}:artifact_path`)
  }
  if (evidence.payload_checksum !== undefined && evidence.payload_checksum !== payload.payload_checksum) {
    blockers.push(`${prefix}:payload_checksum`)
  }
  return blockers
}

export async function expectedReturnSemanticBlockers(
  snapshot: ExpectedReturnSemanticSnapshot,
): Promise<string[]> {
  const blockers: string[] = []
  const pointerByOwner = new Map(snapshot.pointers.map((row) => [row.model_name, row]))
  const registryById = new Map(snapshot.registry.map((row) => [row.artifact_id, row]))
  const payloadById = new Map(snapshot.payloads.map((row) => [row.artifact_id, row]))
  const intervalByOwner = new Map(snapshot.intervals.map((row) => [row.model_name, row]))
  if (snapshot.pointers.length !== EXPECTED_RETURN_POINTER_OWNERS.length) {
    blockers.push(`pointer_count:${snapshot.pointers.length}`)
  }
  for (const owner of EXPECTED_RETURN_POINTER_OWNERS) {
    const pointer = pointerByOwner.get(owner)
    if (!pointer) {
      blockers.push(`pointer:${owner}:missing`)
      continue
    }
    if (!nonEmpty(pointer.champion_version)) blockers.push(`pointer:${owner}:champion_version_blank`)
    if (!nonEmpty(pointer.champion_artifact_id)) blockers.push(`pointer:${owner}:champion_artifact_id_blank`)
    if (!sameInstant(pointer.promoted_at, pointer.promoted_at)) blockers.push(`pointer:${owner}:promoted_at`)
    if (!nonEmpty(pointer.promotion_reason)) blockers.push(`pointer:${owner}:promotion_reason_blank`)
    const current = registryById.get(pointer.champion_artifact_id)
    const currentPayload = payloadById.get(pointer.champion_artifact_id)
    if (!current) blockers.push(`pointer:${owner}:current_registry_missing`)
    else {
      if (current.model_name !== owner) blockers.push(`pointer:${owner}:current_owner`)
      if (current.version !== pointer.champion_version) blockers.push(`pointer:${owner}:current_version`)
      if (current.state !== 'production') blockers.push(`pointer:${owner}:current_state:${current.state}`)
    }
    if (!currentPayload) blockers.push(`pointer:${owner}:current_payload_missing`)
    else if (current) blockers.push(...await expectedReturnArtifactLinkBlockers({
      registry: current,
      payload: currentPayload,
      requireProduction: true,
      label: `pointer:${owner}:current`,
    }))
    const promotionEvidence = parseObject(pointer.promotion_evidence_json)
    if (!promotionEvidence) {
      blockers.push(`pointer:${owner}:promotion_evidence_json_invalid`)
    } else {
      const schemaVersion = String(promotionEvidence.schema_version ?? '')
      if (schemaVersion !== 'expected-return-pointer-promotion-v1') {
        blockers.push(`pointer:${owner}:promotion_evidence_schema`)
      }
      if (promotionEvidence.owner !== undefined && promotionEvidence.owner !== owner) {
        blockers.push(`pointer:${owner}:promotion_evidence_owner`)
      }
      if (
        promotionEvidence.version !== undefined
        && promotionEvidence.version !== pointer.champion_version
      ) blockers.push(`pointer:${owner}:promotion_evidence_version`)
      if (
        promotionEvidence.model_version !== undefined
        && promotionEvidence.model_version !== pointer.champion_version
      ) blockers.push(`pointer:${owner}:promotion_evidence_model_version`)
      if (
        promotionEvidence.artifact_id !== undefined
        && promotionEvidence.artifact_id !== pointer.champion_artifact_id
      ) blockers.push(`pointer:${owner}:promotion_evidence_artifact_id`)
      if (
        current
        && promotionEvidence.artifact_path !== undefined
        && promotionEvidence.artifact_path !== current.artifact_path
      ) blockers.push(`pointer:${owner}:promotion_evidence_artifact_path`)
      if (
        current
        && promotionEvidence.artifact_checksum !== undefined
        && promotionEvidence.artifact_checksum !== current.checksum
      ) blockers.push(`pointer:${owner}:promotion_evidence_artifact_checksum`)
      if (
        currentPayload
        && promotionEvidence.payload_checksum !== undefined
        && promotionEvidence.payload_checksum !== currentPayload.payload_checksum
      ) blockers.push(`pointer:${owner}:promotion_evidence_payload_checksum`)
      if (
        currentPayload
        && promotionEvidence.serving_mode !== undefined
        && promotionEvidence.serving_mode !== currentPayload.serving_mode
      ) blockers.push(`pointer:${owner}:promotion_evidence_serving_mode`)
      const currentArtifact = currentPayload
        ? parseObject(currentPayload.artifact_json)
        : null
      if (
        promotionEvidence.artifact_contract_version !== undefined
        && promotionEvidence.artifact_contract_version
          !== currentArtifact?.artifact_contract_version
      ) blockers.push(`pointer:${owner}:promotion_evidence_artifact_contract_version`)
    }

    const rollbackVersionNull = pointer.rollback_version == null
    const rollbackIdNull = pointer.rollback_artifact_id == null
    if (rollbackVersionNull !== rollbackIdNull) blockers.push(`pointer:${owner}:rollback_pair`)
    if (!rollbackVersionNull && !rollbackIdNull) {
      if (!nonEmpty(pointer.rollback_version) || !nonEmpty(pointer.rollback_artifact_id)) {
        blockers.push(`pointer:${owner}:rollback_blank`)
      } else {
        if (
          pointer.rollback_version === pointer.champion_version
          || pointer.rollback_artifact_id === pointer.champion_artifact_id
        ) blockers.push(`pointer:${owner}:rollback_equals_champion`)
        const rollback = registryById.get(pointer.rollback_artifact_id!)
        const rollbackPayload = payloadById.get(pointer.rollback_artifact_id!)
        if (!rollback) blockers.push(`pointer:${owner}:rollback_registry_missing`)
        else {
          if (rollback.model_name !== owner) blockers.push(`pointer:${owner}:rollback_owner`)
          if (rollback.version !== pointer.rollback_version) blockers.push(`pointer:${owner}:rollback_version`)
        }
        if (!rollbackPayload) blockers.push(`pointer:${owner}:rollback_payload_missing`)
        else if (rollback) blockers.push(...await expectedReturnArtifactLinkBlockers({
          registry: rollback,
          payload: rollbackPayload,
          requireProduction: false,
          label: `pointer:${owner}:rollback`,
        }))
      }
    }

    const interval = intervalByOwner.get(owner)
    if (!interval) blockers.push(`history:${owner}:interval_summary_missing`)
    else {
      if (Number(interval.total_rows) < 1) blockers.push(`history:${owner}:empty`)
      if (Number(interval.open_rows) !== 1) {
        blockers.push(`history:${owner}:open_count:${interval.open_rows}`)
      }
      if (Number(interval.invalid_intervals) !== 0) {
        blockers.push(`history:${owner}:invalid_intervals:${interval.invalid_intervals}`)
      }
      if (Number(interval.unresolved_registry_rows) !== 0) {
        blockers.push(`history:${owner}:unresolved_registry:${interval.unresolved_registry_rows}`)
      }
      if (Number(interval.unresolved_payload_rows) !== 0) {
        blockers.push(`history:${owner}:unresolved_payload:${interval.unresolved_payload_rows}`)
      }
      if (Number(interval.identity_mismatch_rows) !== 0) {
        blockers.push(`history:${owner}:identity_mismatch:${interval.identity_mismatch_rows}`)
      }
      if (Number(interval.invalid_evidence_rows ?? 0) !== 0) {
        blockers.push(`history:${owner}:invalid_evidence:${interval.invalid_evidence_rows}`)
      }
    }
    const ownerHistory = snapshot.history.filter((row) => row.model_name === owner)
    const currentHistory = ownerHistory.find((row) => (
      row.version === pointer.champion_version
      && row.artifact_id === pointer.champion_artifact_id
      && row.retired_at == null
      && sameInstant(row.effective_at, pointer.promoted_at)
    ))
    if (!currentHistory) blockers.push(`history:${owner}:current_pointer_mismatch`)
    if (pointer.rollback_version && pointer.rollback_artifact_id) {
      const rollbackHistory = ownerHistory.find((row) => (
        row.version === pointer.rollback_version
        && row.artifact_id === pointer.rollback_artifact_id
        && row.retired_at != null
      ))
      if (!rollbackHistory) blockers.push(`history:${owner}:rollback_missing_or_open`)
    }
  }
  for (const row of snapshot.history) {
    const registry = registryById.get(row.artifact_id)
    const payload = payloadById.get(row.artifact_id)
    if (!registry) blockers.push(`history:${row.event_id}:registry_missing`)
    else {
      if (registry.model_name !== row.model_name) blockers.push(`history:${row.event_id}:owner`)
      if (registry.version !== row.version) blockers.push(`history:${row.event_id}:version`)
    }
    if (!payload) blockers.push(`history:${row.event_id}:payload_missing`)
    if (registry && payload) {
      blockers.push(...expectedReturnHistoryEvidenceBlockers({ row, registry, payload }))
      blockers.push(...await expectedReturnArtifactLinkBlockers({
        registry,
        payload,
        requireProduction: false,
        label: `history:${row.event_id}:payload`,
      }))
    }
  }
  const l4 = pointerByOwner.get('l4_alpha_ev')
  const fusion = pointerByOwner.get('allocator_ev_fusion')
  const l4Mode = l4 ? payloadById.get(l4.champion_artifact_id)?.serving_mode : null
  const fusionMode = fusion ? payloadById.get(fusion.champion_artifact_id)?.serving_mode : null
  if (fusionMode === 'alpha') {
    const l4Artifact = l4
      ? parseObject(payloadById.get(l4.champion_artifact_id)?.artifact_json)
      : null
    const fusionArtifact = fusion
      ? parseObject(payloadById.get(fusion.champion_artifact_id)?.artifact_json)
      : null
    const servingState = resolveExpectedReturnServingState({
      ensemble_v2: {
        l4_alpha_ev: l4Artifact,
        allocator_ev_fusion: fusionArtifact,
      },
    }, {
      evaluatedAt: '1970-01-01T00:00:00.000Z',
      sourceOfTruth: 'model_champion_pointers+artifact_payloads',
    })
    if (l4Mode !== 'alpha' || !servingState.artifacts.l4_alpha_ev.eligible) {
      blockers.push('fusion_requires_serving_compatible_l4')
    }
    if (!servingState.artifacts.allocator_ev_fusion.eligible) {
      blockers.push(...servingState.artifacts.allocator_ev_fusion.blockers
        .map((blocker) => `fusion_serving_contract:${blocker}`))
    }
  }
  return [...new Set(blockers)]
}

export function changedExpectedReturnSemanticTables(
  before: ExpectedReturnSemanticSnapshot,
  after: ExpectedReturnSemanticSnapshot,
): Array<keyof ExpectedReturnSemanticSnapshot['componentDigests']> {
  return (Object.keys(before.componentDigests) as Array<keyof typeof before.componentDigests>)
    .filter((table) => before.componentDigests[table] !== after.componentDigests[table])
}
