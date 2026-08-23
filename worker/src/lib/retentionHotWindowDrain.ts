import type { Bindings } from '../types'
import { writeEvidenceArtifact } from './artifactLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'
import {
  buildRetentionArchiveOnlyQuery,
  retentionR2PolicyConfig,
  retentionSourceDatabase,
  type RetentionArchiveOnlyPolicyId,
  type RetentionArchiveSource,
} from './retentionArchiveOnly'
import {
  beginRetentionRun,
  checkpointRetentionItem,
  finishRetentionRun,
} from './retentionRunLedger'

export const RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE =
  'DRAIN_VERIFIED_D1_HOT_WINDOWS_V1' as const

export const RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS = [
  'canonical_market_hot_v1',
  'execution_ledger_v1',
  'learning_lineage_v1',
  'market_sessions_hot_v1',
  'price_horizon_ops_v1',
  'price_horizon_rejections_v1',
  'research_runs_v1',
] as const satisfies readonly RetentionArchiveOnlyPolicyId[]

export type RetentionHotWindowDrainPolicyId =
  typeof RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS[number]

type PolicyRow = {
  policy_id: string
  hot_retention_days: number
  cold_retention_days: number | null
  archive_store: string
  action: string
  hard_reference_protected: number
  status: string
}

type DrainDatasetResult = {
  dataset_id: string
  source_domain: string
  cutoff_date: string
  candidates: number
  archived_rows: number
  deleted_rows: number
  archived_bytes: number
  artifact_id: string | null
  checksum: string | null
  backlog_remaining: boolean
  status: 'dry_run' | 'success' | 'skipped' | 'error'
  error?: string
}

type DrainPolicyResult = {
  policy_id: RetentionHotWindowDrainPolicyId
  status: 'dry_run' | 'success' | 'error'
  cutoff_date: string
  scanned_rows: number
  archived_rows: number
  deleted_rows: number
  archived_bytes: number
  backlog_remaining: boolean
  datasets: DrainDatasetResult[]
  error?: string
}

function normalizeBusinessDate(value?: string | null): string {
  const trimmed = String(value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function dateOffset(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`)
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function cleanPart(value: unknown): string {
  return String(value ?? '').replace(/[^A-Za-z0-9_.=-]+/g, '_').slice(0, 140)
}

async function loadPolicy(
  opsDb: D1Database,
  policyId: RetentionHotWindowDrainPolicyId,
): Promise<PolicyRow> {
  const row = await opsDb.prepare(`
    SELECT policy_id, hot_retention_days, cold_retention_days, archive_store,
           action, hard_reference_protected, status
      FROM data_retention_policies
     WHERE policy_id=?
  `).bind(policyId).first<PolicyRow>()
  if (!row) throw new Error(`retention_policy_missing:${policyId}`)
  if (row.status !== 'active') throw new Error(`retention_policy_not_active:${policyId}:${row.status}`)
  if (row.archive_store !== 'r2') {
    throw new Error(`retention_hot_drain_requires_r2:${policyId}:${row.archive_store}`)
  }
  if (row.action !== 'archive_delete') {
    throw new Error(`retention_hot_drain_action_not_archive_delete:${policyId}:${row.action}`)
  }
  if (Number(row.hard_reference_protected) !== 1) {
    throw new Error(`retention_hot_drain_hard_reference_policy_missing:${policyId}`)
  }
  if (Number(row.cold_retention_days ?? 0) <= 0) {
    throw new Error(`retention_hot_drain_cold_window_missing:${policyId}`)
  }
  return row
}

async function loadCandidates(
  db: D1Database,
  source: RetentionArchiveSource,
  cutoffDate: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(buildRetentionArchiveOnlyQuery(source, null))
    .bind(cutoffDate, limit)
    .all<Record<string, unknown>>()
  return result.results ?? []
}

function recheckQuery(source: RetentionArchiveSource, keyCount: number): string {
  const placeholders = Array.from({ length: keyCount }, () => '?').join(',')
  return `
    SELECT * FROM (
      SELECT ${source.keyExpression} AS __cursor_key,
             substr(${source.dateExpression}, 1, 10) AS __archive_date,
             ${source.selectSql}
        FROM ${source.fromSql}
       WHERE (${source.eligibilitySql})
    ) archive_rows
   WHERE __archive_date IS NOT NULL
     AND __archive_date < ?
     AND __cursor_key IN (${placeholders})
   ORDER BY __archive_date ASC, __cursor_key ASC
  `
}

async function assertRowsUnchanged(
  db: D1Database,
  source: RetentionArchiveSource,
  cutoffDate: string,
  archivedRows: Record<string, unknown>[],
): Promise<void> {
  for (let offset = 0; offset < archivedRows.length; offset += 40) {
    const chunk = archivedRows.slice(offset, offset + 40)
    const keys = chunk.map((row) => row.__cursor_key)
    const current = await db.prepare(recheckQuery(source, keys.length))
      .bind(cutoffDate, ...keys)
      .all<Record<string, unknown>>()
    const currentRows = current.results ?? []
    const [expectedChecksum, currentChecksum] = await Promise.all([
      sha256Text(JSON.stringify(chunk)),
      sha256Text(JSON.stringify(currentRows)),
    ])
    if (currentRows.length !== chunk.length || currentChecksum !== expectedChecksum) {
      throw new Error(
        `retention_hot_drain_source_changed:${source.datasetId}:`
        + `expected=${chunk.length} actual=${currentRows.length}`,
      )
    }
  }
}

async function deleteVerifiedRows(
  db: D1Database,
  source: RetentionArchiveSource,
  cutoffDate: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (!source.deleteTable || !source.deleteKeyColumn) {
    throw new Error(`retention_hot_drain_delete_contract_missing:${source.datasetId}`)
  }
  await assertRowsUnchanged(db, source, cutoffDate, rows)
  const keys = rows.map((row) => row.__cursor_key)
  const result = await db.prepare(`
    DELETE FROM ${source.deleteTable}
     WHERE ${source.deleteKeyColumn} IN (SELECT value FROM json_each(?))
       AND substr(${source.dateExpression}, 1, 10) < ?
       AND (${source.eligibilitySql})
    RETURNING ${source.deleteKeyColumn} AS deleted_key
  `).bind(JSON.stringify(keys), cutoffDate).all<{ deleted_key: unknown }>()
  const deletedKeys = (result.results ?? []).map((row) => String(row.deleted_key)).sort()
  const expectedKeys = keys.map((key) => String(key)).sort()
  if (
    deletedKeys.length !== expectedKeys.length
    || deletedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      `retention_hot_drain_delete_mismatch:${source.datasetId}:`
      + `expected=${expectedKeys.length} actual=${deletedKeys.length}`,
    )
  }
  return deletedKeys.length
}

async function runPolicy(
  env: Bindings,
  opsDb: D1Database,
  policyId: RetentionHotWindowDrainPolicyId,
  businessDate: string,
  limit: number,
  dryRun: boolean,
): Promise<DrainPolicyResult> {
  const policy = await loadPolicy(opsDb, policyId)
  const config = retentionR2PolicyConfig(policyId)
  if (!config) throw new Error(`retention_hot_drain_r2_config_missing:${policyId}`)
  const cutoffDate = dateOffset(businessDate, -Number(policy.hot_retention_days))
  const runId = `${dryRun ? 'retention-hot-window-preflight' : 'retention-hot-window-drain'}:`
    + `${policyId}:${businessDate}:${Date.now().toString(36)}`
  const datasets: DrainDatasetResult[] = []
  let scannedRows = 0
  let archivedRows = 0
  let deletedRows = 0
  let archivedBytes = 0
  const errors: string[] = []

  if (!dryRun) await beginRetentionRun(opsDb, { runId, policyId, businessDate })

  const drainSources = config.sources.filter(
    (source) => source.deleteTable && source.deleteKeyColumn,
  )
  for (const source of drainSources) {
    const sourceDb = retentionSourceDatabase(env, source.sourceDomain)
    try {
      const rows = await loadCandidates(sourceDb, source, cutoffDate, limit)
      scannedRows += rows.length
      if (dryRun) {
        datasets.push({
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          cutoff_date: cutoffDate,
          candidates: rows.length,
          archived_rows: 0,
          deleted_rows: 0,
          archived_bytes: 0,
          artifact_id: null,
          checksum: null,
          backlog_remaining: rows.length >= limit,
          status: 'dry_run',
        })
        continue
      }
      if (!rows.length) {
        datasets.push({
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          cutoff_date: cutoffDate,
          candidates: 0,
          archived_rows: 0,
          deleted_rows: 0,
          archived_bytes: 0,
          artifact_id: null,
          checksum: null,
          backlog_remaining: false,
          status: 'skipped',
        })
        await checkpointRetentionItem(opsDb, {
          runId,
          policyId,
          datasetId: `hot-drain:${source.datasetId}`,
          status: 'skipped',
          deletedRows: 0,
          backlogRemaining: false,
          cycleComplete: true,
          evidence: {
            schema_version: 'd1-retention-hot-window-drain-v1',
            delete_executor: true,
            dry_run: false,
            cutoff_date: cutoffDate,
            reason: 'no_eligible_rows',
          },
        })
        continue
      }

      const first = rows[0]
      const last = rows[rows.length - 1]
      const artifact = await writeEvidenceArtifact(env, {
        domain: `retention_${policyId}_${source.datasetId}`,
        businessDate,
        producerRunId: `${runId}:${cleanPart(first.__archive_date)}:`
          + `${cleanPart(first.__cursor_key)}-${cleanPart(last.__cursor_key)}`,
        retentionClass: 'ten_year_cold_archive',
        schemaVersion: 'd1-retention-hot-window-drain-v1',
        rowCount: rows.length,
        payload: {
          schema_version: 'd1-retention-hot-window-drain-v1',
          policy_id: policyId,
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          cutoff_date: cutoffDate,
          hot_retention_days: Number(policy.hot_retention_days),
          cold_retention_days: Number(policy.cold_retention_days),
          row_checksum: await sha256Text(JSON.stringify(rows)),
          coverage_start: first.__archive_date,
          coverage_end: last.__archive_date,
          rows,
        },
        metadata: {
          policy_id: policyId,
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          archive_before_delete: true,
          exact_row_key_recheck: true,
          delete_executor: true,
          dry_run: false,
        },
      })
      const deleted = await deleteVerifiedRows(sourceDb, source, cutoffDate, rows)
      const backlogRemaining = rows.length >= limit
      archivedRows += rows.length
      deletedRows += deleted
      archivedBytes += Number(artifact.byte_size)
      datasets.push({
        dataset_id: source.datasetId,
        source_domain: source.sourceDomain,
        cutoff_date: cutoffDate,
        candidates: rows.length,
        archived_rows: rows.length,
        deleted_rows: deleted,
        archived_bytes: artifact.byte_size,
        artifact_id: artifact.artifact_id,
        checksum: artifact.checksum,
        backlog_remaining: backlogRemaining,
        status: 'success',
      })
      await checkpointRetentionItem(opsDb, {
        runId,
        policyId,
        datasetId: `hot-drain:${source.datasetId}`,
        status: 'success',
        scannedRows: rows.length,
        archivedRows: rows.length,
        deletedRows: deleted,
        archivedBytes: artifact.byte_size,
        backlogRemaining,
        cycleComplete: !backlogRemaining,
        evidence: {
          schema_version: 'd1-retention-hot-window-drain-v1',
          delete_executor: true,
          dry_run: false,
          artifact_id: artifact.artifact_id,
          r2_key: artifact.r2_key,
          checksum: artifact.checksum,
          checksum_verified_at: artifact.checksum_verified_at,
          cutoff_date: cutoffDate,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${source.datasetId}:${message}`)
      datasets.push({
        dataset_id: source.datasetId,
        source_domain: source.sourceDomain,
        cutoff_date: cutoffDate,
        candidates: 0,
        archived_rows: 0,
        deleted_rows: 0,
        archived_bytes: 0,
        artifact_id: null,
        checksum: null,
        backlog_remaining: true,
        status: 'error',
        error: message,
      })
      if (!dryRun) {
        await checkpointRetentionItem(opsDb, {
          runId,
          policyId,
          datasetId: `hot-drain:${source.datasetId}`,
          status: 'error',
          deletedRows: 0,
          backlogRemaining: true,
          error: message,
          evidence: {
            schema_version: 'd1-retention-hot-window-drain-v1',
            delete_executor: true,
            dry_run: false,
            cutoff_date: cutoffDate,
          },
        })
      }
    }
  }

  if (!dryRun) {
    await finishRetentionRun(opsDb, {
      runId,
      status: errors.length ? 'error' : 'success',
      scannedRows,
      archivedRows,
      deletedRows,
      archivedBytes,
      error: errors.join('; ') || null,
    })
  }
  return {
    policy_id: policyId,
    status: dryRun ? 'dry_run' : errors.length ? 'error' : 'success',
    cutoff_date: cutoffDate,
    scanned_rows: scannedRows,
    archived_rows: archivedRows,
    deleted_rows: deletedRows,
    archived_bytes: archivedBytes,
    backlog_remaining: datasets.some((item) => item.backlog_remaining),
    datasets,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

export async function runRetentionHotWindowDrain(
  env: Bindings,
  options: {
    businessDate?: string | null
    policyIds?: readonly RetentionHotWindowDrainPolicyId[]
    limitPerDataset?: number
    confirmPhrase?: string | null
  } = {},
) {
  if (!env.ARTIFACTS) throw new Error('retention_hot_drain_r2_binding_missing')
  const businessDate = normalizeBusinessDate(options.businessDate)
  const limit = Math.max(1, Math.min(Math.floor(options.limitPerDataset ?? 100), 250))
  const dryRun = options.confirmPhrase !== RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE
  const policyIds = [...new Set(options.policyIds ?? RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS)]
  const allowed = new Set<string>(RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS)
  const unknown = policyIds.filter((policyId) => !allowed.has(policyId))
  if (unknown.length) throw new Error(`retention_hot_drain_policy_not_allowed:${unknown.join(',')}`)
  const opsDb = databaseForDataDomain(env, 'ops')
  const policies: DrainPolicyResult[] = []
  for (const policyId of policyIds) {
    policies.push(await runPolicy(env, opsDb, policyId, businessDate, limit, dryRun))
  }
  const failed = policies.filter((policy) => policy.status === 'error')
  return {
    schema_version: 'retention-hot-window-drain-v1' as const,
    status: failed.length ? 'error' as const : dryRun ? 'dry_run' as const : 'success' as const,
    business_date: businessDate,
    dry_run: dryRun,
    delete_executor: true,
    policy_count: policies.length,
    failed_policies: failed.map((policy) => policy.policy_id),
    scanned_rows: policies.reduce((sum, policy) => sum + policy.scanned_rows, 0),
    archived_rows: policies.reduce((sum, policy) => sum + policy.archived_rows, 0),
    deleted_rows: policies.reduce((sum, policy) => sum + policy.deleted_rows, 0),
    archived_bytes: policies.reduce((sum, policy) => sum + policy.archived_bytes, 0),
    backlog_remaining: policies.some((policy) => policy.backlog_remaining),
    policies,
  }
}

export function summarizeRetentionHotWindowDrain(
  result: Awaited<ReturnType<typeof runRetentionHotWindowDrain>>,
): string {
  return [
    `retention_hot_window_drain status=${result.status}`,
    `dry_run=${result.dry_run}`,
    `policies=${result.policy_count}`,
    `scanned=${result.scanned_rows}`,
    `archived=${result.archived_rows}`,
    `deleted=${result.deleted_rows}`,
    `backlog=${result.backlog_remaining}`,
    `failed=${result.failed_policies.join(',') || 'none'}`,
  ].join(' ')
}
