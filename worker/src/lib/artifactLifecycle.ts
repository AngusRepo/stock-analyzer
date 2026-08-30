import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { resolveExpectedCompletedDataDate } from './dataQualityMonitor'
import { sha256Text } from './datasetSnapshots'
import { collectStorageCapacityTelemetry, type StorageCapacityRow } from './storageCapacityTelemetry'
import { inspectSplitDomainSchemaReadiness, type DomainSchemaReadiness } from './storageReadiness'
import type {
  EvidenceArtifactManifest,
  EvidenceArtifactWriteInput,
  RetentionClass,
} from './evidenceArtifactContract'

export type {
  EvidenceArtifactManifest,
  EvidenceArtifactWriteInput,
  RetentionClass,
} from './evidenceArtifactContract'

export type PipelineRunStatus =
  | 'writing'
  | 'validating'
  | 'ready'
  | 'canonical'
  | 'superseded'
  | 'failed'
  | 'reused'

function artifactOpsDb(env: Pick<Bindings, 'DB'>): D1Database {
  return databaseForDataDomain(env as Pick<Bindings, 'DB'> & Partial<Bindings>, 'ops')
}

const RETENTION_DAYS: Record<RetentionClass, number | null> = {
  canonical_execution: 7 * 365,
  canonical_model_evidence: 5 * 365,
  paper_shadow: 2 * 365,
  superseded_run: 2 * 365,
  failed_debug: 90,
  request_debug: 30,
  raw_market_unreferenced: 90,
  staging_orphan: 7,
  ten_year_cold_archive: 10 * 365,
  incident_pinned: null,
}

export const STORAGE_LIFECYCLE_SCHEDULE = [
  { task: 'legacy-hot-data-retirement', cron: '10 1-5 * * *', timezone: 'Asia/Taipei' },
  { task: 'legacy-strategy-evidence-migration', cron: '50 1-5 * * *', timezone: 'Asia/Taipei' },
  { task: 'audit-json-retention', cron: '*/15 1-6 * * *', timezone: 'Asia/Taipei' },
  { task: 'retention-archive-only', cron: '30 2 * * *', timezone: 'Asia/Taipei' },
  { task: 'retention-hot-window-drain', cron: '35 2 * * *', timezone: 'Asia/Taipei' },
  { task: 'artifact-reconcile', cron: '5 2 * * *', timezone: 'Asia/Taipei' },
  { task: 'r2-retention-sweep', cron: '40 2 * * *', timezone: 'Asia/Taipei' },
  { task: 'orphan-reachability-gc', cron: '0 3 * * *', timezone: 'Asia/Taipei' },
  { task: 'storage-health-check', cron: '45 6 * * *', timezone: 'Asia/Taipei' },
  { task: 'learning-retention-readiness', cron: '20 2 * * *', timezone: 'Asia/Taipei' },
  { task: 'legacy-learning-deletion-readiness', cron: '50 6 * * *', timezone: 'Asia/Taipei' },
  { task: 'storage-integrity-audit', cron: '30 3 * * 0', timezone: 'Asia/Taipei' },
  { task: 'weekly-cleanup-v2', cron: '0 4 * * 0', timezone: 'Asia/Taipei' },
  { task: 'storage-capacity-report', cron: '55 6 * * *', timezone: 'Asia/Taipei' },
] as const

function cleanPart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.=-]+/g, '_').slice(0, 160)
}

function retainUntil(retentionClass: RetentionClass, createdAt: string): string | null {
  const days = RETENTION_DAYS[retentionClass]
  if (days == null) return null
  return new Date(new Date(createdAt).getTime() + days * 86_400_000).toISOString()
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function artifactReferenceId(ownerType: string, ownerId: string, artifactId: string): string {
  return `artifact-ref:${cleanPart(ownerType)}:${cleanPart(ownerId)}:${cleanPart(artifactId)}`
}

export async function retainArtifactHardReference(
  db: D1Database,
  input: { artifactId: string; ownerType: string; ownerId: string },
): Promise<void> {
  const referenceId = artifactReferenceId(input.ownerType, input.ownerId, input.artifactId)
  await db.batch([
    db.prepare(`
      INSERT INTO artifact_hard_references (
        reference_id, artifact_id, owner_type, owner_id, active,
        created_at, released_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_type, owner_id, artifact_id) DO UPDATE SET
        active=1, released_at=NULL, updated_at=CURRENT_TIMESTAMP
    `).bind(referenceId, input.artifactId, input.ownerType, input.ownerId),
    db.prepare(`
      UPDATE run_artifacts
         SET hard_ref_count=(
               SELECT COUNT(*) FROM artifact_hard_references r
                WHERE r.artifact_id=run_artifacts.artifact_id AND r.active=1
             ),
             updated_at=CURRENT_TIMESTAMP
       WHERE artifact_id=?
    `).bind(input.artifactId),
  ])
}

export async function releaseArtifactHardReferencesByOwner(
  db: D1Database,
  input: { ownerType: string; ownerId: string },
): Promise<number> {
  const { results } = await db.prepare(`
    SELECT DISTINCT artifact_id
      FROM artifact_hard_references
     WHERE owner_type=? AND owner_id=? AND active=1
  `).bind(input.ownerType, input.ownerId).all<{ artifact_id: string }>()
  const artifactIds = (results ?? []).map((row) => row.artifact_id)
  if (!artifactIds.length) return 0
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      UPDATE artifact_hard_references
         SET active=0, released_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE owner_type=? AND owner_id=? AND active=1
    `).bind(input.ownerType, input.ownerId),
  ]
  for (const artifactId of artifactIds) {
    statements.push(db.prepare(`
      UPDATE run_artifacts
         SET hard_ref_count=(
               SELECT COUNT(*) FROM artifact_hard_references r
                WHERE r.artifact_id=run_artifacts.artifact_id AND r.active=1
             ),
             updated_at=CURRENT_TIMESTAMP
       WHERE artifact_id=?
    `).bind(artifactId))
  }
  await db.batch(statements)
  return artifactIds.length
}

export async function writeEvidenceArtifact(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS' | 'EVIDENCE_ARTIFACT_WRITER'>,
  input: EvidenceArtifactWriteInput,
): Promise<EvidenceArtifactManifest> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  if (!env.ARTIFACTS) {
    if (env.EVIDENCE_ARTIFACT_WRITER) {
      return env.EVIDENCE_ARTIFACT_WRITER.write({ ...input, createdAt })
    }
    throw new Error('artifact_r2_binding_missing')
  }
  const body = JSON.stringify({
    schema_version: input.schemaVersion,
    domain: input.domain,
    business_date: input.businessDate,
    payload: input.payload,
  })
  const checksum = await sha256Text(body)
  const digest = checksum.replace(/^sha256:/, '').slice(0, 24)
  const artifactId = `artifact:${cleanPart(input.domain)}:${cleanPart(input.businessDate)}:${digest}`
  const r2Key = [
    'evidence',
    `class=${input.retentionClass}`,
    `domain=${cleanPart(input.domain)}`,
    `business_date=${cleanPart(input.businessDate)}`,
    `chunk=${digest}.json`,
  ].join('/')

  await (env.ARTIFACTS as any).put(r2Key, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { checksum, schema_version: input.schemaVersion },
  })
  const readback = await (env.ARTIFACTS as any).get(r2Key)
  if (!readback) throw new Error(`artifact_r2_readback_missing:${r2Key}`)
  const readbackBody = await readback.text()
  const readbackChecksum = await sha256Text(readbackBody)
  if (readbackChecksum !== checksum) {
    throw new Error(`artifact_r2_checksum_mismatch:${r2Key}`)
  }

  const verifiedAt = new Date().toISOString()
  const manifest: EvidenceArtifactManifest = {
    artifact_id: artifactId,
    retention_class: input.retentionClass,
    status: 'ready',
    domain: input.domain,
    business_date: input.businessDate,
    producer_run_id: input.producerRunId,
    canonical_run_id: input.canonicalRunId ?? null,
    r2_key: r2Key,
    checksum,
    schema_version: input.schemaVersion,
    row_count: Math.max(0, Math.floor(input.rowCount)),
    byte_size: byteLength(body),
    created_at: createdAt,
    retain_until: retainUntil(input.retentionClass, createdAt),
    checksum_verified_at: verifiedAt,
    metadata_json: JSON.stringify(input.metadata ?? {}),
  }
  await artifactOpsDb(env).prepare(`
    INSERT INTO run_artifacts (
      artifact_id, retention_class, status, domain, business_date,
      producer_run_id, canonical_run_id, r2_key, checksum, schema_version,
      row_count, byte_size, created_at, retain_until, pinned, legal_hold,
      hard_ref_count, checksum_verified_at, metadata_json, updated_at
    ) VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(artifact_id) DO UPDATE SET
      retention_class=excluded.retention_class,
      status='ready',
      domain=excluded.domain,
      business_date=excluded.business_date,
      producer_run_id=excluded.producer_run_id,
      canonical_run_id=COALESCE(excluded.canonical_run_id, run_artifacts.canonical_run_id),
      r2_key=excluded.r2_key,
      checksum=excluded.checksum,
      schema_version=excluded.schema_version,
      row_count=excluded.row_count,
      byte_size=excluded.byte_size,
      retain_until=excluded.retain_until,
      checksum_verified_at=excluded.checksum_verified_at,
      payload_deleted_at=NULL,
      metadata_json=excluded.metadata_json,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    manifest.artifact_id,
    manifest.retention_class,
    manifest.domain,
    manifest.business_date,
    manifest.producer_run_id,
    manifest.canonical_run_id,
    manifest.r2_key,
    manifest.checksum,
    manifest.schema_version,
    manifest.row_count,
    manifest.byte_size,
    manifest.created_at,
    manifest.retain_until,
    manifest.checksum_verified_at,
    manifest.metadata_json,
  ).run()
  return manifest
}

export async function registerPipelineRun(
  db: D1Database,
  input: {
    runId: string
    logicalRunKey: string
    domain: string
    businessDate: string
    stage: string
    inputFingerprint: string
    codeVersion: string
    configVersion: string
    status?: PipelineRunStatus
    market?: string
    mode?: string
    parentRunIds?: string[]
  },
): Promise<{ run_id: string; status: PipelineRunStatus; reused_from_run_id: string | null }> {
  const existing = await db.prepare(`
    SELECT run_id
      FROM pipeline_runs
     WHERE logical_run_key = ?
       AND input_fingerprint = ?
       AND code_version = ?
       AND config_version = ?
       AND status IN ('ready','canonical','superseded','reused')
     ORDER BY updated_at DESC
     LIMIT 1
  `).bind(input.logicalRunKey, input.inputFingerprint, input.codeVersion, input.configVersion)
    .first<{ run_id?: string }>()
  const reusedFrom = existing?.run_id ?? null
  const status: PipelineRunStatus = reusedFrom ? 'reused' : input.status ?? 'writing'
  await db.prepare(`
    INSERT INTO pipeline_runs (
      run_id, logical_run_key, domain, business_date, market, mode, stage,
      status, input_fingerprint, code_version, config_version,
      reused_from_run_id, parent_run_ids_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(run_id) DO UPDATE SET
      logical_run_key=excluded.logical_run_key,
      domain=excluded.domain,
      business_date=excluded.business_date,
      market=excluded.market,
      mode=excluded.mode,
      stage=excluded.stage,
      status=excluded.status,
      input_fingerprint=excluded.input_fingerprint,
      code_version=excluded.code_version,
      config_version=excluded.config_version,
      reused_from_run_id=excluded.reused_from_run_id,
      parent_run_ids_json=excluded.parent_run_ids_json,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    input.runId,
    input.logicalRunKey,
    input.domain,
    input.businessDate,
    input.market ?? 'TW',
    input.mode ?? 'production',
    input.stage,
    status,
    input.inputFingerprint,
    input.codeVersion,
    input.configVersion,
    reusedFrom,
    JSON.stringify(input.parentRunIds ?? []),
  ).run()
  return { run_id: input.runId, status, reused_from_run_id: reusedFrom }
}

export async function promoteCanonicalRun(
  db: D1Database,
  logicalRunKey: string,
  runId: string,
  artifactId: string,
  promotedAt = new Date().toISOString(),
): Promise<{ previous_run_id: string | null }> {
  const run = await db.prepare(`
    SELECT status FROM pipeline_runs WHERE run_id = ? AND logical_run_key = ? LIMIT 1
  `).bind(runId, logicalRunKey).first<{ status?: string }>()
  if (!run || !['ready', 'canonical'].includes(String(run.status))) {
    throw new Error(`canonical_promotion_run_not_ready:${runId}:${run?.status ?? 'missing'}`)
  }
  const artifact = await db.prepare(`
    SELECT status, checksum_verified_at FROM run_artifacts WHERE artifact_id = ? LIMIT 1
  `).bind(artifactId).first<{ status?: string; checksum_verified_at?: string | null }>()
  if (artifact?.status !== 'ready' || !artifact.checksum_verified_at) {
    throw new Error(`canonical_promotion_artifact_not_verified:${artifactId}`)
  }
  const head = await db.prepare(`
    SELECT h.run_id, p.artifact_id
      FROM canonical_run_heads h
      LEFT JOIN pipeline_runs p ON p.run_id=h.run_id
     WHERE h.logical_run_key = ?
     LIMIT 1
  `).bind(logicalRunKey).first<{ run_id?: string; artifact_id?: string | null }>()
  const previousRunId = head?.run_id && head.run_id !== runId ? head.run_id : null
  const previousArtifactId = previousRunId ? String(head?.artifact_id ?? '').trim() || null : null
  const statements: D1PreparedStatement[] = []
  if (previousRunId) {
    statements.push(db.prepare(`
      UPDATE pipeline_runs
         SET status='superseded', superseded_at=?, updated_at=CURRENT_TIMESTAMP
       WHERE run_id=? AND status='canonical'
    `).bind(promotedAt, previousRunId))
  }
  statements.push(
    db.prepare(`
      UPDATE pipeline_runs
         SET status='canonical', artifact_id=?, supersedes_run_id=?, canonical_at=?, updated_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(artifactId, previousRunId, promotedAt, runId),
    db.prepare(`
      INSERT INTO canonical_run_heads (logical_run_key, run_id, previous_run_id, promoted_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(logical_run_key) DO UPDATE SET
        run_id=excluded.run_id,
        previous_run_id=excluded.previous_run_id,
        promoted_at=excluded.promoted_at,
        updated_at=CURRENT_TIMESTAMP
    `).bind(logicalRunKey, runId, previousRunId, promotedAt),
    db.prepare(`
      INSERT INTO artifact_hard_references (
        reference_id, artifact_id, owner_type, owner_id, active,
        created_at, released_at, updated_at
      ) VALUES (?, ?, 'canonical_run_head', ?, 1, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(owner_type, owner_id, artifact_id) DO UPDATE SET
        active=1, released_at=NULL, updated_at=CURRENT_TIMESTAMP
    `).bind(
      artifactReferenceId('canonical_run_head', logicalRunKey, artifactId),
      artifactId,
      logicalRunKey,
    ),
    db.prepare(`
      UPDATE run_artifacts
         SET hard_ref_count=(
               SELECT COUNT(*) FROM artifact_hard_references r
                WHERE r.artifact_id=run_artifacts.artifact_id AND r.active=1
             ),
             updated_at=CURRENT_TIMESTAMP
       WHERE artifact_id=?
    `).bind(artifactId),
  )
  if (previousArtifactId && previousArtifactId !== artifactId) {
    statements.push(
      db.prepare(`
        UPDATE artifact_hard_references
           SET active=0, released_at=?, updated_at=CURRENT_TIMESTAMP
         WHERE owner_type='canonical_run_head' AND owner_id=?
           AND artifact_id=? AND active=1
      `).bind(promotedAt, logicalRunKey, previousArtifactId),
      db.prepare(`
        UPDATE run_artifacts
           SET hard_ref_count=(
                 SELECT COUNT(*) FROM artifact_hard_references r
                  WHERE r.artifact_id=run_artifacts.artifact_id AND r.active=1
               ),
               updated_at=CURRENT_TIMESTAMP
         WHERE artifact_id=?
      `).bind(previousArtifactId),
    )
  }
  await db.batch(statements)
  return { previous_run_id: previousRunId }
}

export async function runR2RetentionSweep(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { now?: string; limit?: number } = {},
): Promise<{ candidates: number; deleted: number; failed: number; errors: string[] }> {
  if (!env.ARTIFACTS) throw new Error('artifact_r2_binding_missing')
  const now = options.now ?? new Date().toISOString()
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 250), 1000))
  const opsDb = artifactOpsDb(env)
  const { results } = await opsDb.prepare(`
    SELECT artifact_id, r2_key
      FROM run_artifacts
     WHERE status = 'ready'
       AND payload_deleted_at IS NULL
       AND retain_until IS NOT NULL
       AND retain_until <= ?
       AND pinned = 0
       AND legal_hold = 0
       AND hard_ref_count = 0
       AND NOT EXISTS (
         SELECT 1 FROM artifact_hard_references r
          WHERE r.artifact_id=run_artifacts.artifact_id AND r.active=1
       )
       AND checksum_verified_at IS NOT NULL
     ORDER BY retain_until, artifact_id
     LIMIT ?
  `).bind(now, limit).all<{ artifact_id: string; r2_key: string }>()
  let deleted = 0
  const errors: string[] = []
  for (const row of results ?? []) {
    try {
      await (env.ARTIFACTS as any).delete(row.r2_key)
      await opsDb.prepare(`
        UPDATE run_artifacts
           SET status='payload_deleted', payload_deleted_at=?, updated_at=CURRENT_TIMESTAMP
         WHERE artifact_id=? AND status='ready'
      `).bind(now, row.artifact_id).run()
      deleted += 1
    } catch (error) {
      errors.push(`${row.artifact_id}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { candidates: (results ?? []).length, deleted, failed: errors.length, errors }
}

type ArtifactIntegrityRow = {
  artifact_id: string
  r2_key: string
  checksum: string
  status: string
}

export type ArtifactIntegrityResult = {
  checked: number
  verified: number
  missing: number
  mismatched: number
  errors: string[]
}

async function verifyArtifactObject(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  row: ArtifactIntegrityRow,
): Promise<'verified' | 'missing' | 'mismatched'> {
  if (!env.ARTIFACTS) throw new Error('artifact_r2_binding_missing')
  const object = await (env.ARTIFACTS as any).get(row.r2_key)
  if (!object) {
    await artifactOpsDb(env).prepare(`
      UPDATE run_artifacts
         SET status='integrity_blocked', updated_at=CURRENT_TIMESTAMP
       WHERE artifact_id=? AND status <> 'payload_deleted'
    `).bind(row.artifact_id).run()
    return 'missing'
  }
  const actual = await sha256Text(await object.text())
  if (actual !== row.checksum) {
    await artifactOpsDb(env).prepare(`
      UPDATE run_artifacts
         SET status='integrity_blocked', updated_at=CURRENT_TIMESTAMP
       WHERE artifact_id=? AND status <> 'payload_deleted'
    `).bind(row.artifact_id).run()
    return 'mismatched'
  }
  await artifactOpsDb(env).prepare(`
    UPDATE run_artifacts
       SET status='ready', checksum_verified_at=COALESCE(checksum_verified_at, CURRENT_TIMESTAMP),
           updated_at=CURRENT_TIMESTAMP
     WHERE artifact_id=? AND status IN ('ready','validating','integrity_blocked')
  `).bind(row.artifact_id).run()
  return 'verified'
}

export async function runArtifactIntegrityAudit(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { limit?: number; includeBlocked?: boolean } = {},
): Promise<ArtifactIntegrityResult> {
  if (!env.ARTIFACTS) throw new Error('artifact_r2_binding_missing')
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500))
  const statuses = options.includeBlocked ? "('ready','validating','integrity_blocked')" : "('ready','validating')"
  const { results } = await artifactOpsDb(env).prepare(`
    SELECT artifact_id, r2_key, checksum, status
      FROM run_artifacts
     WHERE status IN ${statuses}
       AND payload_deleted_at IS NULL
     ORDER BY CASE WHEN checksum_verified_at IS NULL THEN 0 ELSE 1 END,
              updated_at ASC
     LIMIT ?
  `).bind(limit).all<ArtifactIntegrityRow>()
  const result: ArtifactIntegrityResult = {
    checked: 0,
    verified: 0,
    missing: 0,
    mismatched: 0,
    errors: [],
  }
  for (const row of results ?? []) {
    result.checked += 1
    try {
      const status = await verifyArtifactObject(env, row)
      result[status] += 1
    } catch (error) {
      result.errors.push(`${row.artifact_id}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

export async function runArtifactReconcile(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { limit?: number } = {},
): Promise<ArtifactIntegrityResult> {
  return runArtifactIntegrityAudit(env, { limit: options.limit ?? 250, includeBlocked: true })
}

const SCRUB_TARGETS = new Set([
  'strategy_decision_log:decision_id:context_json',
  'strategy_decision_log:decision_id:evidence_json',
  'screener_funnel_runs:run_id:metadata',
  'screener_funnel_runs:run_id:debug_log',
  'screener_funnel_items:id:evidence',
  'paper_execution_events:id:detail_json',
])

export async function runD1EvidenceScrub(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  options: { limit?: number; now?: string } = {},
): Promise<{ candidates: number; scrubbed: number; failed: number; blocked: number; errors: string[] }> {
  const opsDb = artifactOpsDb(env)
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 250), 1000))
  const now = options.now ?? new Date().toISOString()
  const selectRows = async (status: 'failed' | 'pending', rowLimit: number): Promise<any[]> => {
    if (rowLimit <= 0) return []
    const dueClause = status === 'failed'
      ? "q.status='failed' AND q.next_attempt_at <= ?"
      : "q.status='pending' AND q.next_attempt_at IS NULL"
    const orderBy = status === 'failed'
      ? 'q.next_attempt_at, q.created_at'
      : 'q.created_at'
    // multi-d1-domain-owner: queue, artifact registry, and scrub target remain atomic in Ops D1.
    const statement = opsDb.prepare(`
      SELECT q.scrub_id, q.artifact_id, q.target_table, q.target_pk_column,
             q.target_pk_value, q.target_column, q.replacement_json,
             a.status AS artifact_status, a.checksum_verified_at
        FROM artifact_d1_scrub_queue q
        LEFT JOIN run_artifacts a ON a.artifact_id = q.artifact_id
       WHERE ${dueClause}
       ORDER BY ${orderBy}
       LIMIT ?
    `)
    const { results } = status === 'failed'
      ? await statement.bind(now, rowLimit).all<any>()
      : await statement.bind(rowLimit).all<any>()
    return results ?? []
  }

  // Retry a bounded number of due failures first, then drain the pending backlog.
  // Separate predicates preserve the (status, next_attempt_at, created_at) index order.
  const retryRows = await selectRows('failed', Math.min(limit, 50))
  const pendingRows = await selectRows('pending', limit - retryRows.length)
  const results = [...retryRows, ...pendingRows]
  let scrubbed = 0
  let failed = 0
  let blocked = 0
  const errors: string[] = []
  const readyRows: any[] = []
  for (const row of results ?? []) {
    const targetKey = `${row.target_table}:${row.target_pk_column}:${row.target_column}`
    if (row.artifact_status !== 'ready' || !row.checksum_verified_at || !SCRUB_TARGETS.has(targetKey)) {
      // multi-d1-domain-owner: same-Ops-D1 queue state is part of the atomic drain.
      await opsDb.prepare(`
        UPDATE artifact_d1_scrub_queue
           SET status='integrity_blocked', last_error=?, attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
         WHERE scrub_id=?
      `).bind(`unsafe_or_unverified_scrub_target:${targetKey}`, row.scrub_id).run()
      blocked += 1
      continue
    }
    readyRows.push(row)
  }

  const atomicStatements = (row: any): D1PreparedStatement[] => [
    // multi-d1-domain-owner: bounded same-Ops-D1 target mutation.
    opsDb.prepare(`UPDATE ${row.target_table} SET ${row.target_column}=? WHERE ${row.target_pk_column}=?`)
      .bind(row.replacement_json, row.target_pk_value),
    // multi-d1-domain-owner: queue completion commits in the same Ops batch.
    opsDb.prepare(`
      UPDATE artifact_d1_scrub_queue
         SET status='complete', last_error=NULL, attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
       WHERE scrub_id=?
    `).bind(row.scrub_id),
  ]
  const assertBatchSuccess = (batchResults: D1Result[]) => {
    const failedResult = batchResults.find(result => result.success === false)
    if (failedResult) throw new Error(String(failedResult.error ?? 'D1 scrub batch failed'))
  }
  const scrubChunk = async (chunk: any[]): Promise<void> => {
    try {
      assertBatchSuccess(await opsDb.batch(chunk.flatMap(atomicStatements)))
      scrubbed += chunk.length
      return
    } catch (error) {
      if (chunk.length > 1) {
        const midpoint = Math.ceil(chunk.length / 2)
        await scrubChunk(chunk.slice(0, midpoint))
        await scrubChunk(chunk.slice(midpoint))
        return
      }
      const row = chunk[0]
      const message = error instanceof Error ? error.message : String(error)
      // multi-d1-domain-owner: failed Ops drain remains retryable in the owner DB.
      await opsDb.prepare(`
        UPDATE artifact_d1_scrub_queue
           SET status='failed', last_error=?, attempts=attempts+1,
               next_attempt_at=datetime('now', '+' || MIN(60, 1 << MIN(attempts, 5)) || ' minutes'),
               updated_at=CURRENT_TIMESTAMP
         WHERE scrub_id=?
      `).bind(message.slice(0, 1000), row.scrub_id).run()
      failed += 1
      errors.push(`${row.scrub_id}:${message}`)
    }
  }

  for (let index = 0; index < readyRows.length; index += 25) {
    await scrubChunk(readyRows.slice(index, index + 25))
  }
  return { candidates: (results ?? []).length, scrubbed, failed, blocked, errors }
}

export async function runOrphanReachabilityGc(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { now?: Date; limit?: number } = {},
): Promise<{ scanned: number; deleted: number; referenced: number }> {
  if (!env.ARTIFACTS) throw new Error('artifact_r2_binding_missing')
  const now = options.now ?? new Date()
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 500), 1000))
  const listed = await (env.ARTIFACTS as any).list({ prefix: 'staging/uncommitted/', limit })
  let deleted = 0
  let referenced = 0
  for (const object of listed.objects ?? []) {
    const uploaded = object.uploaded instanceof Date ? object.uploaded : new Date(object.uploaded)
    if (!Number.isFinite(uploaded.getTime()) || now.getTime() - uploaded.getTime() < 7 * 86_400_000) continue
    const manifest = await artifactOpsDb(env).prepare(`SELECT artifact_id FROM run_artifacts WHERE r2_key=? LIMIT 1`)
      .bind(object.key).first<{ artifact_id?: string }>()
    if (manifest?.artifact_id) {
      referenced += 1
      continue
    }
    await (env.ARTIFACTS as any).delete(object.key)
    deleted += 1
  }
  return { scanned: (listed.objects ?? []).length, deleted, referenced }
}

export interface StorageHealthResult {
  healthy: boolean
  enforcement_scope: 'scheduler_and_producer_admission'
  admission_control: true
  blocks_storage_producers: true
  blocks_trading_path: false
  integrity_blocked: number
  cleanup_backlog_over_24h: number
  dlq_pending: number
  allocator_ev_snapshot_rows: number
  allocator_ev_snapshot_dates: number
  allocator_snapshot_incomplete_runs: number
  allocator_snapshot_staging_orphans: number
  artifact_hard_ref_drift: number
  artifact_active_references: number
  artifact_true_orphan_references: number
  artifact_true_orphan_ids: string[]
  domain_schema: DomainSchemaReadiness[]
  expected_lineage_date: string | null
  canonical_execution_lineage_ready: boolean
  paper_shadow_lineage_ready: boolean
  legacy_retention_backlog_cohorts: number
  legacy_retention_progress_24h: number
  legacy_retention_stalled: boolean
  d1_bytes: number | null
  d1_utilization: number | null
  capacity_status: StorageCapacityRow['status'] | 'unknown'
  capacity_error: string | null
  legacy_capacity_role: 'active_source' | 'frozen_rollback_source'
  blocking_capacity_domains: string[]
  capacity_domains: Array<{ domain: string; binding_name: string; utilization_pct: number; status: string }>
}

export async function runStorageHealthCheck(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
): Promise<StorageHealthResult> {
  const opsDb = artifactOpsDb(env)
  const learningDb = databaseForDataDomain(env, 'learning')
  let capacityRows: StorageCapacityRow[] = []
  let capacityError: string | null = null
  try {
    const observedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })
    capacityRows = await collectStorageCapacityTelemetry(env, observedDate)
  } catch (error) {
    capacityError = error instanceof Error ? error.message : String(error)
  }
  const counts = await opsDb.prepare(`
    SELECT
      SUM(CASE WHEN status='integrity_blocked' THEN 1 ELSE 0 END) AS integrity_blocked,
      SUM(CASE WHEN status IN ('writing','validating') AND created_at < datetime('now','-24 hours') THEN 1 ELSE 0 END) AS cleanup_backlog_over_24h
    FROM run_artifacts
  `).first<any>()
  const dlq = await opsDb.prepare(`
    SELECT COUNT(*) AS count FROM artifact_cleanup_dlq WHERE status IN ('pending','running','blocked')
  `).first<any>()
  const allocatorSnapshots = await learningDb.prepare(`
    SELECT COUNT(*) AS row_count, COUNT(DISTINCT snapshot_date) AS date_count
      FROM allocator_ev_feature_snapshots
     WHERE snapshot_source='allocator_ev_asof_backfill_v2'
       AND as_of_guard IS NOT NULL
       AND LENGTH(TRIM(as_of_guard)) > 0
  `).first<any>()
  const allocatorSnapshotLifecycle = await learningDb.prepare(`
    SELECT
      SUM(CASE WHEN status='writing' AND updated_at < datetime('now','-2 hours') THEN 1 ELSE 0 END) AS incomplete_runs,
      (SELECT COUNT(*)
         FROM allocator_ev_feature_snapshot_staging s
         JOIN allocator_ev_snapshot_runs r ON r.run_id=s.run_id
        WHERE r.status IN ('writing','failed')
          AND r.updated_at < datetime('now','-7 days')) AS staging_orphans
      FROM allocator_ev_snapshot_runs
  `).first<any>()
  const hardReferences = await opsDb.prepare(`
    SELECT COUNT(*) AS drift_count
      FROM run_artifacts a
     WHERE a.hard_ref_count <> (
       SELECT COUNT(*) FROM artifact_hard_references r
        WHERE r.artifact_id=a.artifact_id AND r.active=1
     )
  `).first<any>()
  const hardReferenceReachability = await opsDb.prepare(`
    SELECT COUNT(*) active_references,
           SUM(CASE WHEN a.artifact_id IS NULL THEN 1 ELSE 0 END) true_orphan_references
      FROM artifact_hard_references r
      LEFT JOIN run_artifacts a ON a.artifact_id=r.artifact_id
     WHERE r.active=1
  `).first<any>()
  const hardReferenceOrphanIds = await opsDb.prepare(`
    SELECT DISTINCT r.artifact_id
      FROM artifact_hard_references r
      LEFT JOIN run_artifacts a ON a.artifact_id=r.artifact_id
     WHERE r.active=1 AND a.artifact_id IS NULL
     ORDER BY r.artifact_id
     LIMIT 25
  `).all<{ artifact_id: string }>()
  const domainSchema = await inspectSplitDomainSchemaReadiness(env)
  const expectedLineageDate = env.KV
    ? await resolveExpectedCompletedDataDate(env.KV, undefined, undefined, 14 * 60 + 35)
    : null
  let executionLineageReady = false
  let paperLineageReady = false
  if (expectedLineageDate) {
    const lineage = await opsDb.prepare(`
      SELECT domain, status, checksum_verified_at,
             ROW_NUMBER() OVER (PARTITION BY domain ORDER BY created_at DESC, artifact_id DESC) ordinal
        FROM run_artifacts
       WHERE business_date=?
         AND domain IN ('execution_daily_closure','paper_daily_closure')
    `).bind(expectedLineageDate).all<{
      domain: string
      status: string
      checksum_verified_at: string | null
      ordinal: number
    }>()
    for (const row of lineage.results ?? []) {
      if (Number(row.ordinal) !== 1) continue
      const ready = row.status === 'ready' && Boolean(row.checksum_verified_at)
      if (row.domain === 'execution_daily_closure') executionLineageReady = ready
      if (row.domain === 'paper_daily_closure') paperLineageReady = ready
    }
  }
  // multi-d1-intentional-legacy-source: this audit measures the retirement
  // backlog remaining in DB; it must not read already-routed domain shards.
  const legacyRetention = await env.DB.prepare(`
    SELECT
      (
        CASE WHEN EXISTS (SELECT 1 FROM strategy_decision_log WHERE context_id IS NULL LIMIT 1) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM screener_funnel_runs r
           WHERE NOT EXISTS (SELECT 1 FROM canonical_run_heads h WHERE h.run_id=r.run_id)
             AND r.run_id <> COALESCE((
               SELECT latest.run_id FROM screener_funnel_runs latest
                WHERE latest.date=r.date AND latest.status='success'
                ORDER BY latest.created_at DESC LIMIT 1
             ), '')
           LIMIT 1
        ) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM pending_buy_items i JOIN pending_buy_runs r ON r.id=i.run_id
           WHERE r.status='superseded' LIMIT 1
        ) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM paper_execution_events e JOIN pending_buy_runs r ON r.id=e.pending_run_id
           WHERE r.status='superseded'
             AND e.event_type IN ('pending_buy','debate','snapshot_audit','finlab_preview','finlab_execution_preview')
           LIMIT 1
        ) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (SELECT 1 FROM predictions WHERE prediction_date IS NULL LIMIT 1) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (SELECT 1 FROM dataset_snapshots WHERE kind='intraday_check_run_report' LIMIT 1) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM state_space_shadow_results WHERE run_date < date('now','-30 days') LIMIT 1
        ) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1
            FROM allocator_ev_snapshot_runs
           WHERE status IN ('writing','failed')
             AND updated_at < datetime('now','-7 days')
           LIMIT 1
        ) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM strategy_decision_log
           WHERE date < date('now','-90 days')
             AND context_id IS NOT NULL AND evidence_artifact_id IS NOT NULL
             AND (
               (LENGTH(COALESCE(context_json,'')) > 64 AND context_json NOT LIKE '%"archived_to_r2":true%') OR
               (LENGTH(COALESCE(evidence_json,'')) > 64 AND evidence_json NOT LIKE '%"archived_to_r2":true%')
             )
           LIMIT 1
        ) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM screener_funnel_items
           WHERE date < date('now','-90 days')
             AND LENGTH(COALESCE(evidence,'')) > 64
             AND evidence NOT LIKE '%"archived_to_r2":true%'
           LIMIT 1
        ) THEN 1 ELSE 0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM paper_execution_events
           WHERE trade_date < date('now','-90 days')
             AND LENGTH(COALESCE(detail_json,'')) > 64
             AND detail_json NOT LIKE '%"archived_to_r2":true%'
           LIMIT 1
        ) THEN 1 ELSE 0 END
      ) AS backlog_cohorts,
      ((SELECT COUNT(*) FROM run_artifacts
         WHERE domain LIKE 'legacy_%'
           AND status='ready'
           AND checksum_verified_at IS NOT NULL
           AND created_at >= datetime('now','-24 hours')) +
       (SELECT COUNT(*) FROM dataset_snapshots
         WHERE kind='d1_audit_json_archive'
           AND status='ready'
           AND created_at >= datetime('now','-24 hours'))) AS progress_24h
  `).first<any>()
  // Cutover and writer-epoch authority is anchored in the legacy source DB.
  // OPS_DB may contain only a stale pre-cutover mirror and must not reclassify
  // the frozen rollback source as an active capacity blocker.
  const frozenDomainReceipt = await env.DB.prepare(`
    SELECT COUNT(DISTINCT c.domain) AS frozen_domains
      FROM data_domain_cutovers c
      JOIN data_domain_writer_epochs w ON w.domain=c.domain
     WHERE c.domain IN ('core','market','learning','ops','execution','paper','research')
       AND c.status='complete'
       AND w.writer_state='cutover'
  `).first<{ frozen_domains?: number }>()

  const legacyCapacity = capacityRows.find((row) => row.domain === 'legacy' && row.binding_name === 'DB')
  const d1Bytes = legacyCapacity?.used_bytes ?? null
  const utilization = d1Bytes == null ? null : d1Bytes / 10_000_000_000
  const capacityStatus = legacyCapacity?.status ?? 'unknown'
  const legacyFrozenRollbackSource = Number(frozenDomainReceipt?.frozen_domains ?? 0) === 7
  const blockingCapacityDomains = capacityRows
    .filter((row) => (
      (row.status === 'drain' || row.status === 'critical')
      && !(row.domain === 'legacy' && legacyFrozenRollbackSource)
    ))
    .map((row) => row.domain)
  const capacityDrain = blockingCapacityDomains.length > 0
  const integrityBlocked = Number(counts?.integrity_blocked ?? 0)
  const backlog = Number(counts?.cleanup_backlog_over_24h ?? 0)
  const dlqPending = Number(dlq?.count ?? 0)
  const allocatorSnapshotRows = Number(allocatorSnapshots?.row_count ?? 0)
  const allocatorSnapshotDates = Number(allocatorSnapshots?.date_count ?? 0)
  const allocatorSnapshotIncompleteRuns = Number(allocatorSnapshotLifecycle?.incomplete_runs ?? 0)
  const allocatorSnapshotStagingOrphans = Number(allocatorSnapshotLifecycle?.staging_orphans ?? 0)
  const artifactHardRefDrift = Number(hardReferences?.drift_count ?? 0)
  const artifactActiveReferences = Number(hardReferenceReachability?.active_references ?? 0)
  const artifactTrueOrphanReferences = Number(hardReferenceReachability?.true_orphan_references ?? 0)
  const domainSchemaReady = domainSchema.every((row) => row.ready)
  const legacyRetentionBacklog = Number(legacyRetention?.backlog_cohorts ?? 0)
  const legacyRetentionProgress24h = Number(legacyRetention?.progress_24h ?? 0)
  const legacyRetentionStalled = legacyRetentionBacklog > 0 && legacyRetentionProgress24h === 0
  return {
    enforcement_scope: 'scheduler_and_producer_admission',
    admission_control: true,
    blocks_storage_producers: true,
    blocks_trading_path: false,
    healthy: integrityBlocked === 0 && backlog === 0 && dlqPending === 0 &&
      allocatorSnapshotRows > 0 && allocatorSnapshotDates > 0 &&
      allocatorSnapshotIncompleteRuns === 0 && allocatorSnapshotStagingOrphans === 0 &&
      artifactHardRefDrift === 0 && artifactTrueOrphanReferences === 0 && domainSchemaReady &&
      (expectedLineageDate == null || (executionLineageReady && paperLineageReady)) &&
      (!legacyRetentionStalled || legacyFrozenRollbackSource) &&
      capacityError == null && capacityRows.length > 0 && !capacityDrain,
    integrity_blocked: integrityBlocked,
    cleanup_backlog_over_24h: backlog,
    dlq_pending: dlqPending,
    allocator_ev_snapshot_rows: allocatorSnapshotRows,
    allocator_ev_snapshot_dates: allocatorSnapshotDates,
    allocator_snapshot_incomplete_runs: allocatorSnapshotIncompleteRuns,
    allocator_snapshot_staging_orphans: allocatorSnapshotStagingOrphans,
    artifact_hard_ref_drift: artifactHardRefDrift,
    artifact_active_references: artifactActiveReferences,
    artifact_true_orphan_references: artifactTrueOrphanReferences,
    artifact_true_orphan_ids: (hardReferenceOrphanIds.results ?? []).map((row) => row.artifact_id),
    domain_schema: domainSchema,
    expected_lineage_date: expectedLineageDate,
    canonical_execution_lineage_ready: executionLineageReady,
    paper_shadow_lineage_ready: paperLineageReady,
    legacy_retention_backlog_cohorts: legacyRetentionBacklog,
    legacy_retention_progress_24h: legacyRetentionProgress24h,
    legacy_retention_stalled: legacyRetentionStalled,
    d1_bytes: d1Bytes,
    d1_utilization: utilization,
    capacity_status: capacityStatus,
    capacity_error: capacityError,
    legacy_capacity_role: legacyFrozenRollbackSource
      ? 'frozen_rollback_source'
      : 'active_source',
    blocking_capacity_domains: blockingCapacityDomains,
    capacity_domains: capacityRows.map((row) => ({
      domain: row.domain,
      binding_name: row.binding_name,
      utilization_pct: row.utilization_pct,
      status: row.status,
    })),
  }
}

export async function runCleanupDlqReplay(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { limit?: number } = {},
): Promise<{ candidates: number; resolved: number; blocked: number }> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500))
  const opsDb = artifactOpsDb(env)
  const { results } = await opsDb.prepare(`
    SELECT dlq_id, artifact_id
      FROM artifact_cleanup_dlq
     WHERE status IN ('pending','blocked')
       AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
     ORDER BY created_at, dlq_id
     LIMIT ?
  `).bind(limit).all<{ dlq_id: string; artifact_id?: string | null }>()
  if (!(results ?? []).length) return { candidates: 0, resolved: 0, blocked: 0 }

  await runArtifactReconcile(env, { limit: Math.max(limit, 250) })
  let resolved = 0
  let blocked = 0
  for (const row of results ?? []) {
    const artifact = row.artifact_id
      ? await opsDb.prepare(`SELECT status FROM run_artifacts WHERE artifact_id=? LIMIT 1`)
        .bind(row.artifact_id).first<{ status?: string }>()
      : null
    if (artifact?.status === 'ready') {
      await opsDb.prepare(`
        UPDATE artifact_cleanup_dlq
           SET status='resolved', attempts=attempts+1, last_error=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE dlq_id=?
      `).bind(row.dlq_id).run()
      resolved += 1
    } else {
      await opsDb.prepare(`
        UPDATE artifact_cleanup_dlq
           SET status='blocked', attempts=attempts+1,
               next_attempt_at=datetime('now', '+' || MIN(1440, 1 << MIN(attempts, 10)) || ' minutes'),
               updated_at=CURRENT_TIMESTAMP
         WHERE dlq_id=?
      `).bind(row.dlq_id).run()
      blocked += 1
    }
  }
  return { candidates: (results ?? []).length, resolved, blocked }
}
