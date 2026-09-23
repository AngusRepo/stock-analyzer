import { inspectDataDomainCutoverReadiness } from './dataDomainCutoverReadiness'
import { tablesForDataDomainShadowBackfill } from './dataDomainRegistry'
import { retentionR2PolicyConfig } from './retentionArchiveOnly'

export const LEARNING_HOT_RETENTION_DAYS = 120 as const
export const LEARNING_COLD_RETENTION_DAYS = 3650 as const
export const LEGACY_LEARNING_EARLIEST_CLEAR_DATE = '2026-09-17' as const
export const LEGACY_LEARNING_TABLE_MANIFEST = tablesForDataDomainShadowBackfill('learning')

type DatasetSpec = {
  table: string
  dateColumn: string
}

const LEARNING_DATASETS: readonly DatasetSpec[] =
  (retentionR2PolicyConfig('learning_lineage_v1')?.sources ?? [])
    .filter(source => source.deleteTable && source.deleteKeyColumn)
    .map(source => ({ table: source.datasetId, dateColumn: source.dateExpression.split('.')[1] }))
const LEARNING_COLD_READER_PENDING = (retentionR2PolicyConfig('learning_lineage_v1')?.sources ?? [])
  .filter(source => !source.deleteTable).map(source => source.datasetId)

export function learningRetentionBlockers(input: {
  policyReady: boolean; navReady: boolean; asOfDate: string;
  datasets: ReadonlyArray<{ dataset_id: string; candidate_rows: number }>;
  receipts: ReadonlyArray<{ dataset_id: string; status: string; backlog_remaining: number; updated_at: string }>;
  readerBlockedDatasets?: readonly string[];
}) {
  const blockers: string[] = []
  if (!input.policyReady) blockers.push('learning_retention_policy_not_ready')
  if (!input.navReady) blockers.push('nav_cold_storage_not_closed')
  for (const dataset of input.readerBlockedDatasets ?? []) blockers.push(`cold_reader_not_verified:${dataset}`)
  const since = isoDateDaysBefore(input.asOfDate, 2)
  const byDataset = new Map(input.receipts.map(row => [row.dataset_id, row]))
  for (const dataset of input.datasets) {
    const row = byDataset.get(`hot-drain:${dataset.dataset_id}`)
    const date = String(row?.updated_at ?? '').slice(0, 10)
    if (!row || row.status !== 'cycle_complete' || Number(row.backlog_remaining) !== 0
      || date < since || date > input.asOfDate)
      blockers.push(`retention_executor_not_current:${dataset.dataset_id}`)
    if (dataset.candidate_rows > 0) blockers.push(`retention_backlog:${dataset.dataset_id}`)
  }
  return blockers
}

function isoDateDaysBefore(asOfDate: string, days: number): string {
  const timestamp = Date.parse(`${asOfDate}T00:00:00Z`)
  if (!Number.isFinite(timestamp)) throw new Error('invalid_retention_as_of_date')
  return new Date(timestamp - (days * 86_400_000)).toISOString().slice(0, 10)
}

function numeric(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function inspectDataset(db: D1Database, dataset: DatasetSpec, cutoffDate: string) {
  const row = await db.prepare(
    `SELECT COUNT(*) candidate_rows, MIN(${dataset.dateColumn}) oldest_date, MAX(${dataset.dateColumn}) newest_date
       FROM ${dataset.table}
      WHERE ${dataset.dateColumn} < ?`,
  ).bind(cutoffDate).first<Record<string, unknown>>()
  return {
    dataset_id: dataset.table,
    date_column: dataset.dateColumn,
    cutoff_date: cutoffDate,
    candidate_rows: numeric(row?.candidate_rows),
    oldest_candidate_date: row?.oldest_date == null ? null : String(row.oldest_date),
    newest_candidate_date: row?.newest_date == null ? null : String(row.newest_date),
  }
}

export async function inspectNavColdStorageReadiness(db: D1Database) {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .bind('paired_nav_cold_objects_v1').first<Record<string, unknown>>()
  if (!exists) return { ready: false, migration_ready: false, reason: 'paired_nav_cold_migration_0048_missing' }
  const snapshots = await db.prepare(`SELECT COUNT(*) total_snapshots,
    SUM(CASE WHEN c.snapshot_id IS NOT NULL AND c.payload_checksum=m.payload_checksum THEN 1 ELSE 0 END) cold_snapshots,
    COALESCE(SUM(c.payload_bytes),0) cold_payload_bytes
    FROM paired_nav_frozen_manifests_v1 m LEFT JOIN paired_nav_cold_objects_v1 c ON c.snapshot_id=m.snapshot_id`)
    .first<Record<string, unknown>>()
  // Index/count only: never scan gigabytes of payload_text for routine telemetry.
  const parts = await db.prepare(`SELECT COUNT(*) hot_parts,
    SUM(CASE WHEN m.snapshot_id IS NULL THEN 1 ELSE 0 END) orphan_parts
    FROM paired_nav_frozen_parts_v1 p LEFT JOIN paired_nav_frozen_manifests_v1 m ON m.snapshot_id=p.snapshot_id`)
    .first<Record<string, unknown>>()
  const pending = numeric(snapshots?.total_snapshots) - numeric(snapshots?.cold_snapshots)
  return { ready: pending === 0 && numeric(parts?.hot_parts) === 0, migration_ready: true,
    store: 'gcs', storage_policy: 'cold_at_write', minimum_cold_days: 3650,
    immutable_hold: 'release_requires_governance_after_retention',
    snapshots: numeric(snapshots?.total_snapshots), cold_snapshots: numeric(snapshots?.cold_snapshots),
    cold_payload_bytes: numeric(snapshots?.cold_payload_bytes), snapshots_pending_archive: pending,
    legacy_hot_parts: numeric(parts?.hot_parts), orphan_parts: numeric(parts?.orphan_parts),
    automatic_delete: false, orphan_policy: 'verified_forensic_backup_and_writer_fence_no_nav_credit' }
}

export async function inspectLearningTenYearRetentionReadiness(
  learningDb: D1Database,
  opsDb: D1Database,
  asOfDate: string,
) {
  const hotCutoffDate = isoDateDaysBefore(asOfDate, LEARNING_HOT_RETENTION_DAYS)
  const [datasets, policy, runTotals, navCold, executorReceipts] = await Promise.all([
    Promise.all(LEARNING_DATASETS.map((dataset) => inspectDataset(learningDb, dataset, hotCutoffDate))),
    opsDb.prepare(
      `SELECT policy_id, hot_retention_days, cold_retention_days, archive_store, action,
              hard_reference_protected, version, status
         FROM data_retention_policies
        WHERE policy_id='learning_lineage_v1'`,
    ).first<Record<string, unknown>>(),
    opsDb.prepare(
      `SELECT COUNT(*) run_count, COALESCE(SUM(scanned_rows), 0) scanned_rows,
              COALESCE(SUM(archived_rows), 0) archived_rows,
              COALESCE(SUM(deleted_rows), 0) deleted_rows,
              MAX(completed_at) last_completed_at
         FROM data_retention_runs
        WHERE policy_id='learning_lineage_v1'`,
    ).first<Record<string, unknown>>(),
    inspectNavColdStorageReadiness(learningDb),
    opsDb.prepare(`SELECT dataset_id,status,backlog_remaining,updated_at
      FROM data_retention_cursors WHERE policy_id='learning_lineage_v1'
      AND dataset_id LIKE 'hot-drain:%'`).all<{
        dataset_id: string; status: string; backlog_remaining: number; updated_at: string
      }>(),
  ])
  const policyReady = numeric(policy?.hot_retention_days) === LEARNING_HOT_RETENTION_DAYS
    && numeric(policy?.cold_retention_days) === LEARNING_COLD_RETENTION_DAYS
    && policy?.archive_store === 'r2'
    && policy?.action === 'archive_delete'
    && numeric(policy?.hard_reference_protected) === 1
    && policy?.status === 'active'
  const blockers = learningRetentionBlockers({ policyReady, navReady: navCold.ready,
    asOfDate, datasets, receipts: executorReceipts.results ?? [],
    readerBlockedDatasets: LEARNING_COLD_READER_PENDING })
  return {
    schema_version: 'learning-ten-year-retention-readiness-v2' as const,
    mode: 'read_only_audit' as const,
    as_of_date: asOfDate,
    hot_days: LEARNING_HOT_RETENTION_DAYS,
    cold_days: LEARNING_COLD_RETENTION_DAYS,
    hot_cutoff_date: hotCutoffDate,
    policy_ready: policyReady,
    nav_cold_storage: navCold,
    complete: blockers.length === 0,
    blockers,
    cold_reader_pending_datasets: LEARNING_COLD_READER_PENDING,
    executor_receipts: executorReceipts.results ?? [],
    policy: policy ?? null,
    candidate_rows: datasets.reduce((sum, dataset) => sum + dataset.candidate_rows, 0),
    datasets,
    retention_runs: {
      run_count: numeric(runTotals?.run_count),
      scanned_rows: numeric(runTotals?.scanned_rows),
      archived_rows: numeric(runTotals?.archived_rows),
      deleted_rows: numeric(runTotals?.deleted_rows),
      last_completed_at: runTotals?.last_completed_at == null ? null : String(runTotals.last_completed_at),
    },
    automatic_delete: false,
    delete_executor_available: true,
    delete_executor: 'retention-hot-window-drain-v1',
    next_action: blockers.length ? 'close_reader_restore_executor_and_backlog_evidence' : 'continue_daily_capacity_and_retention_verification',
  }
}

export async function inspectLegacyLearningDeletionReadiness(
  controlDb: D1Database,
  learningDb: D1Database,
  asOfDate: string,
) {
  const [cutover, writer, projections, probe, cursors, parity] = await Promise.all([
    controlDb.prepare(
      `SELECT status, parity_checked_at, updated_at
         FROM data_domain_cutovers WHERE domain='learning'`,
    ).first<Record<string, unknown>>(),
    controlDb.prepare(
      `SELECT epoch, writer_state, updated_at
         FROM data_domain_writer_epochs WHERE domain='learning'`,
    ).first<Record<string, unknown>>(),
    controlDb.prepare(
      `SELECT SUM(CASE WHEN status <> 'published' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) errors
         FROM domain_projection_outbox
        WHERE source_domain='learning' OR target_domain='learning'`,
    ).first<Record<string, unknown>>(),
    controlDb.prepare(
      `SELECT status, source_epoch, parity_checked_at, read_write_readback_passed,
              rollback_restore_passed, checked_at
         FROM data_domain_cutover_probe_receipts
        WHERE domain='learning'
        ORDER BY checked_at DESC LIMIT 1`,
    ).first<Record<string, unknown>>(),
    controlDb.prepare(
      `SELECT COUNT(*) tracked_tables,
              SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) completed_tables,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_tables
         FROM data_domain_backfill_cursors
        WHERE domain='learning'`,
    ).first<Record<string, unknown>>(),
    controlDb.prepare(
      `SELECT COUNT(*) checked_tables,
              SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) matched_tables
         FROM (
           SELECT table_name, status,
                  ROW_NUMBER() OVER (PARTITION BY table_name ORDER BY checked_at DESC) rn
             FROM data_domain_parity_checks
            WHERE domain='learning' AND check_kind='full_table'
         ) WHERE rn=1`,
    ).first<Record<string, unknown>>(),
  ])
  const cutoverReadiness = await inspectDataDomainCutoverReadiness(controlDb, 'learning', {
    upstreamTerminalReady: true,
    learningTargetDb: learningDb,
  })
  const domainReadiness = cutoverReadiness.domains[0] ?? null
  const blockers: string[] = []
  if (asOfDate < LEGACY_LEARNING_EARLIEST_CLEAR_DATE) blockers.push('time_travel_observation_window_not_complete')
  if (cutover?.status !== 'complete') blockers.push('learning_cutover_not_complete')
  if (writer?.writer_state !== 'cutover') blockers.push('legacy_learning_writer_not_cutover')
  if (numeric(projections?.pending) > 0) blockers.push('projection_pending_not_zero')
  if (numeric(projections?.errors) > 0) blockers.push('projection_errors_not_zero')
  if (
    probe?.status !== 'passed'
    || numeric(probe?.read_write_readback_passed) !== 1
    || numeric(probe?.rollback_restore_passed) !== 1
  ) blockers.push('rollback_probe_not_passed')
  const expectedTables = LEGACY_LEARNING_TABLE_MANIFEST.length
  if (
    numeric(cursors?.tracked_tables) !== expectedTables
    || numeric(cursors?.completed_tables) !== expectedTables
    || numeric(cursors?.failed_tables) > 0
  ) blockers.push('legacy_learning_66_table_backfill_not_complete')
  if (
    numeric(parity?.checked_tables) !== expectedTables
    || numeric(parity?.matched_tables) !== expectedTables
  ) blockers.push('legacy_learning_66_table_parity_not_complete')
  if (cutover?.status !== 'complete' && !domainReadiness?.cutover_ready) {
    blockers.push(...(domainReadiness?.blockers ?? ['learning_cutover_readiness_missing']))
  }
  return {
    schema_version: 'legacy-learning-deletion-readiness-v1' as const,
    mode: 'read_only_audit' as const,
    as_of_date: asOfDate,
    earliest_clear_date: LEGACY_LEARNING_EARLIEST_CLEAR_DATE,
    technical_ready_for_explicit_approval: blockers.length === 0,
    delete_authorized: false,
    automatic_delete: false,
    requires_explicit_wei_approval: true,
    blockers,
    evidence: {
      cutover: cutover ?? null,
      writer: writer ?? null,
      projections: {
        pending: numeric(projections?.pending),
        errors: numeric(projections?.errors),
      },
      probe: probe ?? null,
      legacy_learning_manifest: {
        expected_tables: expectedTables,
        tables: LEGACY_LEARNING_TABLE_MANIFEST,
        tracked_tables: numeric(cursors?.tracked_tables),
        completed_tables: numeric(cursors?.completed_tables),
        failed_tables: numeric(cursors?.failed_tables),
      },
      parity: {
        checked_tables: numeric(parity?.checked_tables),
        matched_tables: numeric(parity?.matched_tables),
      },
      deletion_gate_policy: 'formal_cutover_receipt_plus_time_travel_window',
      post_cutover_target_drift: cutover?.status === 'complete'
        ? domainReadiness?.blockers ?? []
        : [],
      cutover_readiness: domainReadiness,
    },
  }
}
