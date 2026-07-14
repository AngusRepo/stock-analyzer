import type { Bindings } from '../types'
import { sha256Text } from './datasetSnapshots'
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

const RETENTION_DAYS: Record<RetentionClass, number | null> = {
  canonical_execution: 7 * 365,
  canonical_model_evidence: 5 * 365,
  paper_shadow: 2 * 365,
  superseded_run: 2 * 365,
  failed_debug: 90,
  request_debug: 30,
  raw_market_unreferenced: 90,
  staging_orphan: 7,
  incident_pinned: null,
}

export const STORAGE_LIFECYCLE_SCHEDULE = [
  { task: 'artifact-reconcile', cron: '5 2 * * *', timezone: 'Asia/Taipei' },
  { task: 'd1-evidence-scrub', cron: '*/20 2-6 * * *', timezone: 'Asia/Taipei' },
  { task: 'r2-retention-sweep', cron: '40 2 * * *', timezone: 'Asia/Taipei' },
  { task: 'orphan-reachability-gc', cron: '0 3 * * *', timezone: 'Asia/Taipei' },
  { task: 'cleanup-dlq-replay', cron: '20 3 * * *', timezone: 'Asia/Taipei' },
  { task: 'storage-health-gate', cron: '45 6 * * *', timezone: 'Asia/Taipei' },
  { task: 'storage-integrity-audit', cron: '30 3 * * 0', timezone: 'Asia/Taipei' },
  { task: 'weekly-cleanup-v2', cron: '0 4 * * 0', timezone: 'Asia/Taipei' },
  { task: 'storage-capacity-report', cron: '30 4 1 * *', timezone: 'Asia/Taipei' },
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
  await env.DB.prepare(`
    INSERT OR REPLACE INTO run_artifacts (
      artifact_id, retention_class, status, domain, business_date,
      producer_run_id, canonical_run_id, r2_key, checksum, schema_version,
      row_count, byte_size, created_at, retain_until, pinned, legal_hold,
      hard_ref_count, checksum_verified_at, metadata_json, updated_at
    ) VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, CURRENT_TIMESTAMP)
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
    INSERT OR REPLACE INTO pipeline_runs (
      run_id, logical_run_key, domain, business_date, market, mode, stage,
      status, input_fingerprint, code_version, config_version,
      reused_from_run_id, parent_run_ids_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
    SELECT run_id FROM canonical_run_heads WHERE logical_run_key = ? LIMIT 1
  `).bind(logicalRunKey).first<{ run_id?: string }>()
  const previousRunId = head?.run_id && head.run_id !== runId ? head.run_id : null
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
  )
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
  const { results } = await env.DB.prepare(`
    SELECT artifact_id, r2_key
      FROM run_artifacts
     WHERE status = 'ready'
       AND payload_deleted_at IS NULL
       AND retain_until IS NOT NULL
       AND retain_until <= ?
       AND pinned = 0
       AND legal_hold = 0
       AND hard_ref_count = 0
       AND checksum_verified_at IS NOT NULL
     ORDER BY retain_until, artifact_id
     LIMIT ?
  `).bind(now, limit).all<{ artifact_id: string; r2_key: string }>()
  let deleted = 0
  const errors: string[] = []
  for (const row of results ?? []) {
    try {
      await (env.ARTIFACTS as any).delete(row.r2_key)
      await env.DB.prepare(`
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
    await env.DB.prepare(`
      UPDATE run_artifacts
         SET status='integrity_blocked', updated_at=CURRENT_TIMESTAMP
       WHERE artifact_id=? AND status <> 'payload_deleted'
    `).bind(row.artifact_id).run()
    return 'missing'
  }
  const actual = await sha256Text(await object.text())
  if (actual !== row.checksum) {
    await env.DB.prepare(`
      UPDATE run_artifacts
         SET status='integrity_blocked', updated_at=CURRENT_TIMESTAMP
       WHERE artifact_id=? AND status <> 'payload_deleted'
    `).bind(row.artifact_id).run()
    return 'mismatched'
  }
  await env.DB.prepare(`
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
  const { results } = await env.DB.prepare(`
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
  env: Pick<Bindings, 'DB'>,
  options: { limit?: number; now?: string } = {},
): Promise<{ candidates: number; scrubbed: number; failed: number; blocked: number; errors: string[] }> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 250), 1000))
  const now = options.now ?? new Date().toISOString()
  const { results } = await env.DB.prepare(`
    SELECT q.scrub_id, q.artifact_id, q.target_table, q.target_pk_column,
           q.target_pk_value, q.target_column, q.replacement_json,
           a.status AS artifact_status, a.checksum_verified_at
      FROM artifact_d1_scrub_queue q
      LEFT JOIN run_artifacts a ON a.artifact_id = q.artifact_id
     WHERE q.status IN ('pending','failed')
       AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
     ORDER BY q.created_at, q.scrub_id
     LIMIT ?
  `).bind(now, limit).all<any>()
  let scrubbed = 0
  let failed = 0
  let blocked = 0
  const errors: string[] = []
  const readyRows: any[] = []
  for (const row of results ?? []) {
    const targetKey = `${row.target_table}:${row.target_pk_column}:${row.target_column}`
    if (row.artifact_status !== 'ready' || !row.checksum_verified_at || !SCRUB_TARGETS.has(targetKey)) {
      await env.DB.prepare(`
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
    env.DB.prepare(`UPDATE ${row.target_table} SET ${row.target_column}=? WHERE ${row.target_pk_column}=?`)
      .bind(row.replacement_json, row.target_pk_value),
    env.DB.prepare(`
      UPDATE artifact_d1_scrub_queue
         SET status='complete', last_error=NULL, attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
       WHERE scrub_id=?
    `).bind(row.scrub_id),
  ]
  const assertBatchSuccess = (batchResults: D1Result[]) => {
    const failedResult = batchResults.find(result => result.success === false)
    if (failedResult) throw new Error(String(failedResult.error ?? 'D1 scrub batch failed'))
  }

  for (let index = 0; index < readyRows.length; index += 25) {
    const chunk = readyRows.slice(index, index + 25)
    try {
      assertBatchSuccess(await env.DB.batch(chunk.flatMap(atomicStatements)))
      scrubbed += chunk.length
      continue
    } catch {
      // Retry each row atomically so one malformed legacy row cannot block the batch.
    }
    for (const row of chunk) {
      try {
        assertBatchSuccess(await env.DB.batch(atomicStatements(row)))
        scrubbed += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await env.DB.prepare(`
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
    const manifest = await env.DB.prepare(`SELECT artifact_id FROM run_artifacts WHERE r2_key=? LIMIT 1`)
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

export async function runStorageHealthGate(
  env: Pick<Bindings, 'DB'>,
): Promise<{
  healthy: boolean
  integrity_blocked: number
  cleanup_backlog_over_24h: number
  dlq_pending: number
  d1_bytes: number | null
  d1_utilization: number | null
}> {
  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status='integrity_blocked' THEN 1 ELSE 0 END) AS integrity_blocked,
      SUM(CASE WHEN status IN ('writing','validating') AND created_at < datetime('now','-24 hours') THEN 1 ELSE 0 END) AS cleanup_backlog_over_24h
    FROM run_artifacts
  `).first<any>()
  const dlq = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM artifact_cleanup_dlq WHERE status IN ('pending','running','blocked')
  `).first<any>()
  let d1Bytes: number | null = null
  try {
    // D1's Worker binding does not expose PRAGMA page_count/page_size through
    // prepared statements. Every query result carries the authoritative
    // database size in meta.size_after, so use that runtime source instead.
    const sizeProbe = await env.DB.prepare('SELECT 1 AS storage_health_probe').all()
    const sizeAfter = Number(sizeProbe.meta?.size_after)
    if (Number.isFinite(sizeAfter) && sizeAfter >= 0) d1Bytes = sizeAfter
  } catch {
    d1Bytes = null
  }
  const maxBytes = 10_000_000_000
  const utilization = d1Bytes == null ? null : d1Bytes / maxBytes
  const integrityBlocked = Number(counts?.integrity_blocked ?? 0)
  const backlog = Number(counts?.cleanup_backlog_over_24h ?? 0)
  const dlqPending = Number(dlq?.count ?? 0)
  return {
    healthy: integrityBlocked === 0 && backlog === 0 && dlqPending === 0 && utilization != null && utilization < 0.8,
    integrity_blocked: integrityBlocked,
    cleanup_backlog_over_24h: backlog,
    dlq_pending: dlqPending,
    d1_bytes: d1Bytes,
    d1_utilization: utilization,
  }
}

export async function runCleanupDlqReplay(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { limit?: number } = {},
): Promise<{ candidates: number; resolved: number; blocked: number }> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500))
  const { results } = await env.DB.prepare(`
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
      ? await env.DB.prepare(`SELECT status FROM run_artifacts WHERE artifact_id=? LIMIT 1`)
        .bind(row.artifact_id).first<{ status?: string }>()
      : null
    if (artifact?.status === 'ready') {
      await env.DB.prepare(`
        UPDATE artifact_cleanup_dlq
           SET status='resolved', attempts=attempts+1, last_error=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE dlq_id=?
      `).bind(row.dlq_id).run()
      resolved += 1
    } else {
      await env.DB.prepare(`
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
