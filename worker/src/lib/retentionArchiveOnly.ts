import type { Bindings } from '../types'
import type { RetentionClass } from './evidenceArtifactContract'
import { writeEvidenceArtifact } from './artifactLifecycle'
import { databaseForDataDomain, type DataDomain } from './dataDomainRegistry'
import {
  beginRetentionRun,
  checkpointRetentionItem,
  finishRetentionRun,
  loadRetentionCursor,
} from './retentionRunLedger'

export const RETENTION_ARCHIVE_ONLY_POLICY_IDS = [
  'canonical_market_hot_v1',
  'execution_ledger_v1',
  'learning_lineage_v1',
  'legacy_hot_r2_v1',
  'market_sessions_hot_v1',
  'oof_lineage_cold_archive_v2',
  'price_horizon_ops_v1',
  'price_horizon_rejections_v1',
  'research_runs_v1',
] as const

export type RetentionArchiveOnlyPolicyId = typeof RETENTION_ARCHIVE_ONLY_POLICY_IDS[number]
export type ArchiveSourceDomain = DataDomain | 'legacy'

export type RetentionArchiveSource = {
  datasetId: string
  sourceDomain: ArchiveSourceDomain
  fromSql: string
  selectSql: string
  dateExpression: string
  keyExpression: string
  eligibilitySql: string
  deleteTable?: string
  deleteKeyColumn?: string
}

export type R2PolicyConfig = {
  store: 'r2'
  retentionClass: RetentionClass
  sources: readonly RetentionArchiveSource[]
}

type GcsPreflightConfig = {
  store: 'gcs'
  sources: ReadonlyArray<{
    datasetId: 'active8_oof_predictions' | 'allocator_ev_oof_snapshots' | 'l4_oof_predictions'
    dateColumn: 'prediction_date' | 'snapshot_date'
  }>
}

type PolicyConfig = R2PolicyConfig | GcsPreflightConfig

function tableSource(
  sourceDomain: ArchiveSourceDomain,
  table: string,
  dateColumn: string,
  eligibilitySql = '1=1',
): RetentionArchiveSource {
  return {
    datasetId: table,
    sourceDomain,
    fromSql: table,
    selectSql: `${table}.*`,
    dateExpression: `${table}.${dateColumn}`,
    keyExpression: `${table}.rowid`,
    eligibilitySql,
    deleteTable: table,
    deleteKeyColumn: 'rowid',
  }
}


function archiveOnlyTableSource(
  sourceDomain: ArchiveSourceDomain,
  table: string,
  dateColumn: string,
  eligibilitySql = '1=1',
): RetentionArchiveSource {
  return {
    ...tableSource(sourceDomain, table, dateColumn, eligibilitySql),
    deleteTable: undefined,
    deleteKeyColumn: undefined,
  }
}
const POLICY_CONFIGS: Record<RetentionArchiveOnlyPolicyId, PolicyConfig> = {
  canonical_market_hot_v1: {
    store: 'r2',
    retentionClass: 'ten_year_cold_archive',
    sources: [
      tableSource('market', 'stock_prices', 'date'),
      tableSource('market', 'technical_indicators', 'date'),
      tableSource('market', 'chip_data', 'date'),
      tableSource('market', 'margin_data', 'date'),
      tableSource('market', 'canonical_fundamental_features', 'available_date'),
    ],
  },
  execution_ledger_v1: {
    store: 'r2',
    retentionClass: 'ten_year_cold_archive',
    sources: [
      tableSource('execution', 'broker_execution_intents', 'trade_date'),
      tableSource('execution', 'broker_execution_legs', 'created_at'),
      tableSource('execution', 'broker_execution_events', 'event_time'),
    ],
  },
  learning_lineage_v1: {
    store: 'r2',
    retentionClass: 'ten_year_cold_archive',
    sources: [
      tableSource('learning', 'predictions', 'prediction_date'),
      tableSource('learning', 'strategy_decision_log', 'date'),
      tableSource('learning', 's12_replay_trade_outcomes', 'trade_date'),
      tableSource('learning', 's12_structure_snapshots', 'trade_date'),
      archiveOnlyTableSource('learning', 'dataset_snapshots', 'business_date'),
      tableSource('learning', 'selection_reference_snapshots_v1', 'signal_date'),
      tableSource('learning', 'strategy_label_matrix_v4', 'signal_date'),
      tableSource('learning', 'canonical_selection_labels_v4', 'signal_date'),
      tableSource('learning', 'canonical_selection_outcomes_v1', 'signal_date'),
      tableSource('learning', 'price_horizon_labels_v1', 'price_date'),
      tableSource('learning', 'price_horizon_labels_v2', 'price_date'),
    ],
  },
  legacy_hot_r2_v1: {
    store: 'r2',
    retentionClass: 'superseded_run',
    sources: [
      {
        datasetId: 'obsolete_screener_items',
        sourceDomain: 'legacy',
        fromSql: 'screener_funnel_items i',
        selectSql: 'i.*',
        dateExpression: 'i.date',
        keyExpression: 'i.rowid',
        eligibilitySql: `NOT EXISTS (SELECT 1 FROM canonical_run_heads h WHERE h.run_id=i.run_id)
          AND i.run_id <> COALESCE((
            SELECT latest.run_id FROM screener_funnel_runs latest
             WHERE latest.date=i.date AND latest.status='success'
             ORDER BY latest.created_at DESC LIMIT 1
          ), '')`,
      },
      {
        datasetId: 'superseded_pending_items',
        sourceDomain: 'legacy',
        fromSql: 'pending_buy_items i JOIN pending_buy_runs r ON r.id=i.run_id',
        selectSql: 'i.*, r.trade_date AS source_trade_date, r.status AS source_run_status',
        dateExpression: 'r.trade_date',
        keyExpression: 'i.rowid',
        eligibilitySql: `r.status='superseded'`,
      },
      {
        datasetId: 'superseded_pending_events',
        sourceDomain: 'legacy',
        fromSql: 'paper_execution_events e JOIN pending_buy_runs r ON r.id=e.pending_run_id',
        selectSql: 'e.*, r.status AS source_run_status',
        dateExpression: 'e.trade_date',
        keyExpression: 'e.rowid',
        eligibilitySql: `r.status='superseded'
          AND e.event_type IN ('pending_buy','debate','snapshot_audit','finlab_preview','finlab_execution_preview')`,
      },
      {
        datasetId: 'null_date_predictions',
        sourceDomain: 'legacy',
        fromSql: 'predictions p',
        selectSql: 'p.*',
        dateExpression: `substr(p.generated_at, 1, 10)`,
        keyExpression: 'p.rowid',
        eligibilitySql: 'p.prediction_date IS NULL',
      },
      tableSource('legacy', 'dataset_snapshots', 'business_date',
        `dataset_snapshots.kind='intraday_check_run_report'
          AND dataset_snapshots.status='ready'
          AND dataset_snapshots.r2_key IS NOT NULL`),
      tableSource('legacy', 'state_space_shadow_results', 'run_date'),
      tableSource('legacy', 'allocator_ev_snapshot_runs', 'updated_at',
        `allocator_ev_snapshot_runs.status IN ('writing','failed')`),
    ],
  },
  market_sessions_hot_v1: {
    store: 'r2',
    retentionClass: 'ten_year_cold_archive',
    sources: [tableSource('market', 'market_trading_sessions', 'session_date')],
  },
  oof_lineage_cold_archive_v2: {
    store: 'gcs',
    sources: [
      { datasetId: 'active8_oof_predictions', dateColumn: 'prediction_date' },
      { datasetId: 'allocator_ev_oof_snapshots', dateColumn: 'snapshot_date' },
      { datasetId: 'l4_oof_predictions', dateColumn: 'prediction_date' },
    ],
  },
  price_horizon_ops_v1: {
    store: 'r2',
    retentionClass: 'canonical_model_evidence',
    sources: [tableSource('ops', 'price_horizon_projection_runs', 'outcome_as_of_date')],
  },
  price_horizon_rejections_v1: {
    store: 'r2',
    retentionClass: 'superseded_run',
    sources: [tableSource('learning', 'price_horizon_label_rejections_v1', 'price_date')],
  },
  research_runs_v1: {
    store: 'r2',
    retentionClass: 'canonical_model_evidence',
    sources: [
      tableSource('research', 'backtest_results', 'run_date'),
      tableSource('research', 'monte_carlo_results', 'run_date'),
      tableSource('research', 'pbo_results', 'run_date'),
      tableSource('research', 'strategy_mining_runs', 'run_date'),
      tableSource('research', 'analysis_runs', 'created_at'),
    ],
  },
}

export function retentionArchiveOnlyPolicyConfig(policyId: RetentionArchiveOnlyPolicyId): PolicyConfig {
  return POLICY_CONFIGS[policyId]
}

export function retentionR2PolicyConfig(policyId: RetentionArchiveOnlyPolicyId): R2PolicyConfig | null {
  const config = POLICY_CONFIGS[policyId]
  return config.store === 'r2' ? config : null
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

function sourceDatabase(env: Bindings, domain: ArchiveSourceDomain): D1Database {
  return domain === 'legacy' ? env.DB : databaseForDataDomain(env, domain)
}

export function retentionSourceDatabase(
  env: Bindings,
  domain: ArchiveSourceDomain,
): D1Database {
  return sourceDatabase(env, domain)
}

export function buildRetentionArchiveOnlyQuery(
  source: RetentionArchiveSource,
  cursor: { cursor_date: string | null; cursor_key: string | null } | null,
): string {
  const cursorPredicate = cursor?.cursor_date && cursor.cursor_key != null
    ? 'AND (__archive_date > ? OR (__archive_date = ? AND __cursor_key > ?))'
    : ''
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
     ${cursorPredicate}
   ORDER BY __archive_date ASC, __cursor_key ASC
   LIMIT ?
  `
}

async function loadRows(
  db: D1Database,
  source: RetentionArchiveSource,
  cutoffDate: string,
  limit: number,
  cursor: { cursor_date: string | null; cursor_key: string | null } | null,
): Promise<Record<string, unknown>[]> {
  const cursorBinds = cursor?.cursor_date && cursor.cursor_key != null
    ? [cursor.cursor_date, cursor.cursor_date, cursor.cursor_key]
    : []
  const result = await db.prepare(buildRetentionArchiveOnlyQuery(source, cursor))
    .bind(cutoffDate, ...cursorBinds, limit)
    .all<Record<string, unknown>>()
  return result.results ?? []
}

type PolicyRow = {
  policy_id: string
  hot_retention_days: number
  cold_retention_days: number | null
  archive_store: string
  hard_reference_protected: number
  status: string
}

async function loadPolicy(opsDb: D1Database, policyId: RetentionArchiveOnlyPolicyId): Promise<PolicyRow> {
  const row = await opsDb.prepare(`
    SELECT policy_id, hot_retention_days, cold_retention_days, archive_store,
           hard_reference_protected, status
      FROM data_retention_policies
     WHERE policy_id=?
  `).bind(policyId).first<PolicyRow>()
  if (!row) throw new Error(`retention_policy_missing:${policyId}`)
  if (row.status !== 'active') throw new Error(`retention_policy_not_active:${policyId}:${row.status}`)
  if (row.archive_store !== POLICY_CONFIGS[policyId].store) {
    throw new Error(`retention_archive_store_mismatch:${policyId}:${row.archive_store}`)
  }
  if (Number(row.hard_reference_protected) !== 1) {
    throw new Error(`retention_hard_reference_policy_missing:${policyId}`)
  }
  return row
}

type ArchivePolicyResult = {
  policy_id: RetentionArchiveOnlyPolicyId
  status: 'success' | 'error'
  store: 'r2' | 'gcs'
  scanned_rows: number
  archived_rows: number
  deleted_rows: 0
  archived_bytes: number
  backlog_remaining: boolean
  error?: string
}

async function runR2Policy(
  env: Bindings,
  opsDb: D1Database,
  policyId: RetentionArchiveOnlyPolicyId,
  policy: PolicyRow,
  config: R2PolicyConfig,
  businessDate: string,
  limit: number,
): Promise<ArchivePolicyResult> {
  if (!env.ARTIFACTS) throw new Error('retention_archive_r2_binding_missing')
  const runId = `retention-archive-only:${policyId}:${businessDate}:${Date.now().toString(36)}`
  const cutoffDate = dateOffset(businessDate, -Number(policy.hot_retention_days))
  let scannedRows = 0
  let archivedRows = 0
  let archivedBytes = 0
  let backlogRemaining = false
  const errors: string[] = []
  await beginRetentionRun(opsDb, { runId, policyId, businessDate })

  for (const source of config.sources) {
    const cursor = await loadRetentionCursor(opsDb, policyId, source.datasetId)
    try {
      const rows = await loadRows(sourceDatabase(env, source.sourceDomain), source, cutoffDate, limit, cursor)
      scannedRows += rows.length
      if (!rows.length) {
        await checkpointRetentionItem(opsDb, {
          runId, policyId, datasetId: source.datasetId, status: 'skipped', deletedRows: 0,
          cursorDate: cursor?.cursor_date ?? null,
          cursorKey: cursor?.cursor_key ?? null,
          backlogRemaining: false,
          evidence: { archive_only: true, archive_store: 'r2', cutoff_date: cutoffDate, reason: 'no_new_eligible_rows' },
        })
        continue
      }

      const first = rows[0]
      const last = rows[rows.length - 1]
      const artifact = await writeEvidenceArtifact(env, {
        domain: `retention_${policyId}_${source.datasetId}`,
        businessDate,
        producerRunId: `${runId}:${cleanPart(first.__archive_date)}:${cleanPart(first.__cursor_key)}-${cleanPart(last.__cursor_key)}`,
        retentionClass: config.retentionClass,
        schemaVersion: 'd1-retention-archive-only-v1',
        rowCount: rows.length,
        payload: {
          schema_version: 'd1-retention-archive-only-v1',
          policy_id: policyId,
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          archive_store: 'r2',
          archive_only: true,
          hard_reference_protected: true,
          deleted_rows: 0,
          hot_retention_days: Number(policy.hot_retention_days),
          cold_retention_days: policy.cold_retention_days == null ? null : Number(policy.cold_retention_days),
          cutoff_date: cutoffDate,
          coverage_start: first.__archive_date,
          coverage_end: last.__archive_date,
          rows,
        },
        metadata: {
          policy_id: policyId,
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          archive_only: true,
          deleted_rows: 0,
          hard_reference_protected: true,
          manual_delete_approval_required: true,
        },
      })
      archivedRows += rows.length
      archivedBytes += Number(artifact.byte_size)
      const sourceBacklog = rows.length >= limit
      backlogRemaining ||= sourceBacklog
      await checkpointRetentionItem(opsDb, {
        runId, policyId, datasetId: source.datasetId, status: 'success',
        scannedRows: rows.length, archivedRows: rows.length, deletedRows: 0,
        archivedBytes: artifact.byte_size,
        cursorDate: String(last.__archive_date ?? '') || null,
        cursorKey: String(last.__cursor_key ?? '') || null,
        backlogRemaining: sourceBacklog,
        evidence: {
          archive_only: true,
          archive_store: 'r2',
          artifact_id: artifact.artifact_id,
          r2_key: artifact.r2_key,
          checksum: artifact.checksum,
          checksum_verified_at: artifact.checksum_verified_at,
          deleted_rows: 0,
          cutoff_date: cutoffDate,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${source.datasetId}:${message}`)
      backlogRemaining = true
      await checkpointRetentionItem(opsDb, {
        runId, policyId, datasetId: source.datasetId, status: 'error', deletedRows: 0,
        backlogRemaining: true, error: message,
        evidence: { archive_only: true, archive_store: 'r2', deleted_rows: 0 },
      })
    }
  }

  await finishRetentionRun(opsDb, {
    runId,
    status: errors.length ? 'error' : 'success',
    scannedRows,
    archivedRows,
    deletedRows: 0,
    archivedBytes,
    error: errors.join('; ') || null,
  })
  return {
    policy_id: policyId,
    status: errors.length ? 'error' : 'success',
    store: 'r2',
    scanned_rows: scannedRows,
    archived_rows: archivedRows,
    deleted_rows: 0,
    archived_bytes: archivedBytes,
    backlog_remaining: backlogRemaining,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

async function runGcsPreflightPolicy(
  env: Bindings,
  opsDb: D1Database,
  policyId: RetentionArchiveOnlyPolicyId,
  policy: PolicyRow,
  config: GcsPreflightConfig,
  businessDate: string,
): Promise<ArchivePolicyResult> {
  const runId = `retention-archive-only:${policyId}:${businessDate}:${Date.now().toString(36)}`
  const cutoffDate = dateOffset(businessDate, -Number(policy.hot_retention_days))
  const learningDb = databaseForDataDomain(env, 'learning')
  const errors: string[] = []
  let scannedRows = 0
  await beginRetentionRun(opsDb, { runId, policyId, businessDate })
  for (const source of config.sources) {
    const countRow = await learningDb.prepare(`
      SELECT COUNT(*) AS cold_rows
        FROM ${source.datasetId}
       WHERE ${source.dateColumn} < ?
    `).bind(cutoffDate).first<{ cold_rows?: number }>()
    const coldRows = Math.max(0, Number(countRow?.cold_rows ?? 0))
    scannedRows += coldRows
    if (coldRows > 0) {
      const message = `gcs_archive_payload_approval_required:cold_rows=${coldRows}`
      errors.push(`${source.datasetId}:${message}`)
      await checkpointRetentionItem(opsDb, {
        runId, policyId, datasetId: source.datasetId, status: 'error', scannedRows: coldRows,
        deletedRows: 0, backlogRemaining: true, error: message,
        evidence: { archive_only: true, archive_store: 'gcs', deleted_rows: 0, cutoff_date: cutoffDate },
      })
    } else {
      await checkpointRetentionItem(opsDb, {
        runId, policyId, datasetId: source.datasetId, status: 'skipped', deletedRows: 0,
        backlogRemaining: false,
        evidence: {
          archive_only: true,
          archive_store: 'gcs',
          deleted_rows: 0,
          cutoff_date: cutoffDate,
          reason: 'no_eligible_cold_rows_no_payload_transfer',
        },
      })
    }
  }
  await finishRetentionRun(opsDb, {
    runId, status: errors.length ? 'error' : 'success', scannedRows,
    archivedRows: 0, deletedRows: 0, archivedBytes: 0, error: errors.join('; ') || null,
  })
  return {
    policy_id: policyId,
    status: errors.length ? 'error' : 'success',
    store: 'gcs',
    scanned_rows: scannedRows,
    archived_rows: 0,
    deleted_rows: 0,
    archived_bytes: 0,
    backlog_remaining: errors.length > 0,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

export async function runRetentionArchiveOnly(
  env: Bindings,
  options: {
    businessDate?: string | null
    policyIds?: readonly RetentionArchiveOnlyPolicyId[]
    limitPerDataset?: number
  } = {},
) {
  const businessDate = normalizeBusinessDate(options.businessDate)
  const limit = Math.max(1, Math.min(Math.floor(options.limitPerDataset ?? 100), 250))
  const policyIds = [...new Set(options.policyIds ?? RETENTION_ARCHIVE_ONLY_POLICY_IDS)]
  const opsDb = databaseForDataDomain(env, 'ops')
  const results: ArchivePolicyResult[] = []
  for (const policyId of policyIds) {
    if (!RETENTION_ARCHIVE_ONLY_POLICY_IDS.includes(policyId)) {
      throw new Error(`retention_archive_only_policy_not_allowed:${policyId}`)
    }
    const policy = await loadPolicy(opsDb, policyId)
    const config = POLICY_CONFIGS[policyId]
    results.push(config.store === 'r2'
      ? await runR2Policy(env, opsDb, policyId, policy, config, businessDate, limit)
      : await runGcsPreflightPolicy(env, opsDb, policyId, policy, config, businessDate))
  }
  const failed = results.filter((result) => result.status === 'error')
  return {
    schema_version: 'retention-archive-only-run-v1' as const,
    status: failed.length ? 'error' as const : 'success' as const,
    business_date: businessDate,
    archive_only: true,
    deleted_rows: 0 as const,
    policy_count: results.length,
    successful_policies: results.length - failed.length,
    failed_policies: failed.map((result) => result.policy_id),
    scanned_rows: results.reduce((sum, result) => sum + result.scanned_rows, 0),
    archived_rows: results.reduce((sum, result) => sum + result.archived_rows, 0),
    archived_bytes: results.reduce((sum, result) => sum + result.archived_bytes, 0),
    backlog_remaining: results.some((result) => result.backlog_remaining),
    policies: results,
  }
}

export function summarizeRetentionArchiveOnly(result: Awaited<ReturnType<typeof runRetentionArchiveOnly>>): string {
  return [
    `retention_archive_only status=${result.status}`,
    `date=${result.business_date}`,
    `policies=${result.successful_policies}/${result.policy_count}`,
    `scanned=${result.scanned_rows}`,
    `archived=${result.archived_rows}`,
    `deleted=${result.deleted_rows}`,
    `bytes=${result.archived_bytes}`,
    `backlog_remaining=${result.backlog_remaining}`,
    `failed=${result.failed_policies.join(',') || 'none'}`,
  ].join(' ')
}
