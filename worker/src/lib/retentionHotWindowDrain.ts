import { prepareReplayReleaseProjection, type ReplayReleaseProjection } from './retentionS12ReplayProjection'
import { retentionReplayClockMetadata } from './retentionReplayClocks'
import { runRetentionDrainRounds } from './retentionDrainRounds'
import { reconcileRetentionReleases } from './retentionReleaseReconciliation'
import { retireRecentUnreleasedArchives, retireUnreleasedArchive } from './retentionOrphanArchives'
import { releaseArchivedRows } from './retentionSourceRelease'
import type { Bindings } from '../types'
import { writeEvidenceArtifact } from './artifactLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import { sha256Text } from './datasetSnapshots'
import { buildBoundedRetentionSelect, RETENTION_CHUNK_MAX_BYTES } from './retentionExactRows'
import {
  retentionR2PolicyConfig,
  retentionSourceAtCutoff,
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

// Longest window a scheduled reader without a cold-archive path reads from D1. The drain
// cutoff never passes it, even when an ops policy row is shortened. Readers with longer
// windows are either retired under l4Distribution or read archives (retention_history.py).
// bufferDays keeps a reader whose run_date is up to that many days older than the drain's
// business date (next-day rerun, retry after a holiday) exact; older windows reach the archive
// and those readers merge it or stop with a named reason (retention_prediction_reads).
export const RETENTION_HOT_READER_FLOORS: Readonly<Record<string, { days: number; bufferDays: number; readers: readonly string[] }>> = {
  predictions: { days: 120, bufferDays: 7, readers: [
    'worker/src/lib/controllerResearchWorkflows.ts:runOpbArmPriorRefresh lookback_days',
    'worker/src/lib/priceHorizonProjection.ts:DEFAULT_LOOKBACK_DAYS',
    'ml-controller/services/s12_trade_ev_bootstrap.py:lookback_days',
  ] },
}

/**
 * Delete cutoff: rows strictly older stay eligible; the policy and the reader floor both bound it.
 * Floored datasets never count from a future business date, so archived rows are always older
 * than Taipei today minus the floor (ml-controller retention_prediction_reads relies on this).
 */
export function retentionHotDrainCutoff(businessDate: string, hotRetentionDays: number, datasetId: string,
  today = taipeiToday()): string {
  const reader = RETENTION_HOT_READER_FLOORS[datasetId]
  const floor = reader ? reader.days + reader.bufferDays : undefined
  const days = Math.max(hotRetentionDays, floor ?? 0)
  return dateOffset(floor == null || businessDate <= today ? businessDate : today, -days)
}

function taipeiToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

// NEW-D08: drain size per call comes from Worker vars `<env>_DEFAULT` / `<env>_MAX` instead of
// literals. Unset vars keep 100/250 rows, 1/10 rounds and a 60/120 s budget. The per-pass row
// ceiling stays 250 because buildExactRetentionDelete deletes at most 250 rows per statement.
// Vars alone do not raise nightly throughput (~8.4k predictions rows/night from 2027-01): the
// nightly job is a dry-run preflight (one round) and pins limit_per_dataset in its query. Using
// the vars needs them in wrangler.toml [vars] (dashboard vars are dropped on deploy), a scheduler
// query change, and a separately approved confirm_drain. Budget is checked between passes, so its
// ceiling stays within the default 180 s Cloud Scheduler attempt deadline of a sync job.
const HOT_DRAIN_SETTINGS = {
  limitPerDataset: { env: 'RETENTION_HOT_DRAIN_LIMIT_PER_DATASET', default: 100, max: 250, ceiling: 250 },
  maxRounds: { env: 'RETENTION_HOT_DRAIN_MAX_ROUNDS', default: 1, max: 10, ceiling: 100 },
  budgetMs: { env: 'RETENTION_HOT_DRAIN_BUDGET_MS', default: 60_000, max: 120_000, ceiling: 180_000 },
} as const

export type RetentionHotDrainSettings = Record<keyof typeof HOT_DRAIN_SETTINGS, { default: number; max: number }>

/** Resolve drain settings from Worker vars; a malformed or out-of-range value fails closed. */
export function retentionHotDrainSettings(env: object): RetentionHotDrainSettings {
  const vars = env as Record<string, unknown>
  const read = (name: string, fallback: number, ceiling: number) => {
    const raw = vars[name]
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
    const text = String(raw).trim()
    const value = /^\d+$/.test(text) ? Number(text) : NaN
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`retention_hot_drain_setting_invalid:${name}`)
    }
    return value
  }
  const settings = {} as RetentionHotDrainSettings
  for (const key of Object.keys(HOT_DRAIN_SETTINGS) as (keyof typeof HOT_DRAIN_SETTINGS)[]) {
    const spec = HOT_DRAIN_SETTINGS[key]
    const max = read(`${spec.env}_MAX`, spec.max, spec.ceiling)
    settings[key] = { default: read(`${spec.env}_DEFAULT`, Math.min(spec.default, max), max), max }
  }
  return settings
}

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
  status: 'dry_run' | 'success' | 'skipped' | 'blocked' | 'error'
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
  // Archive-only sources without a verified cold reader: not drained, not a policy error.
  blocked_datasets: string[]
  datasets: DrainDatasetResult[]
  error?: string
}

// Pilot: one call drains only the oldest eligible day of each source, so size_after can be
// compared with that day's bytes. The day is pinned for every round of the call.
type PilotDays = Map<string, string>

async function pilotCutoff(db: D1Database, source: RetentionArchiveSource, cutoffDate: string,
  pilot: PilotDays): Promise<string> {
  const key = `${source.sourceDomain}:${source.datasetId}`
  const pinned = pilot.get(key)
  if (pinned) return pinned
  const row = await db.prepare(`SELECT MIN(${source.dateExpression}) AS oldest FROM ${source.fromSql}
    WHERE (${source.scanEligibilitySql ?? source.eligibilitySql}) AND ${source.dateExpression}<?`)
    .bind(cutoffDate).first<{ oldest: string | null }>()
  const oldest = String(row?.oldest ?? '').slice(0, 10)
  const next = /^\d{4}-\d{2}-\d{2}$/.test(oldest) ? dateOffset(oldest, 1) : cutoffDate
  const cutoff = next < cutoffDate ? next : cutoffDate
  pilot.set(key, cutoff)
  return cutoff
}

async function rowsRemainBefore(db: D1Database, source: RetentionArchiveSource, from: string, cutoffDate: string) {
  if (from >= cutoffDate) return false
  return await db.prepare(`SELECT 1 FROM ${source.fromSql} WHERE (${source.scanEligibilitySql ?? source.eligibilitySql})
    AND ${source.dateExpression}>=? AND ${source.dateExpression}<? LIMIT 1`).bind(from, cutoffDate).first() != null
}

function normalizeBusinessDate(value?: string | null): string {
  const trimmed = String(value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  return taipeiToday()
}

function dateOffset(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`)
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function predictionArchiveKeys(rows: Record<string, unknown>[]) {
  const generated = rows.map(row => String(row.generated_at ?? '')).filter(Boolean).sort()
  // Ensemble stock ids per prediction_date: set readers (price-horizon candidate dates and ids)
  // answer from the manifest without downloading the chunk.
  const ensemble: Record<string, number[]> = {}
  for (const row of rows) {
    if (row.model_name !== 'ensemble' || typeof row.prediction_date !== 'string') continue
    const ids = ensemble[row.prediction_date] ??= []
    if (!ids.includes(Number(row.stock_id))) ids.push(Number(row.stock_id))
  }
  return { stock_keys: [...new Set(rows.map(row => row.stock_id))], ensemble_stock_dates: ensemble,
    ...(generated.length === rows.length ? { generated_coverage_start: generated[0], generated_coverage_end: generated.at(-1) } : {}) }
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
): Promise<{ rows: Record<string, unknown>[]; hasMore: boolean }> {
  const info = await db.prepare('SELECT name FROM pragma_table_info(?)')
    .bind(source.deleteTable).all<{ name: string }>()
  const sql = buildBoundedRetentionSelect(source, (info.results ?? []).map(row => row.name))
  const result = await db.prepare(sql).bind(cutoffDate, limit, RETENTION_CHUNK_MAX_BYTES).all<Record<string, unknown>>()
  const rows = result.results ?? []
  const last = rows.at(-1)
  const dateColumn = source.dateExpression.split('.')[1]
  if (!dateColumn || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dateColumn)) throw new Error('retention_source_date_invalid')
  const after = last ? `AND (${source.dateExpression}>? OR (${source.dateExpression}=? AND ${source.keyExpression}>?))` : ''
  const binds = last ? [cutoffDate, last[dateColumn], last[dateColumn], last.__cursor_key] : [cutoffDate]
  const next = await db.prepare(`SELECT 1 FROM ${source.fromSql} WHERE (${source.scanEligibilitySql ?? source.eligibilitySql})
    AND ${source.dateExpression}<? ${after} LIMIT 1`).bind(...binds).first()
  if (!rows.length && next) throw new Error(`retention_row_requires_large_object_path:${source.datasetId}`)
  return { rows, hasMore: next != null }
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
   ORDER BY ${source.dateExpression.split('.')[1]} ASC, __cursor_key ASC
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
  artifact: { artifact_id: string; checksum: string },
  projection?: ReplayReleaseProjection,
): Promise<number> {
  await assertRowsUnchanged(db, source, cutoffDate, rows)
  return releaseArchivedRows(db, source, cutoffDate, rows, artifact, projection)
}

type CheckpointInput = Parameters<typeof checkpointRetentionItem>[1]
type CursorState = { status: string; backlog_remaining: number; last_error: string | null; updated_today: number }
// A no-op ledger entry (blocked source, or no eligible rows) whose cursor would not change.
type DeferredCheckpoint = { input: CheckpointInput; blocked: boolean; cursorStatus: 'running' | 'cycle_complete' }

async function loadPolicyCursors(opsDb: D1Database, policyId: string): Promise<Map<string, CursorState>> {
  // PRIMARY KEY(policy_id, dataset_id) prefix seek; one row per dataset of the policy.
  const { results } = await opsDb.prepare(`
    SELECT dataset_id, status, backlog_remaining, last_error,
           date(updated_at) = date('now') AS updated_today
      FROM data_retention_cursors
     WHERE policy_id=?
  `).bind(policyId).all<CursorState & { dataset_id: string }>()
  return new Map((results ?? []).map((row) => [row.dataset_id, row]))
}

function cursorUnchanged(cursors: Map<string, CursorState>, item: DeferredCheckpoint): boolean {
  const cursor = cursors.get(item.input.datasetId)
  return cursor != null && cursor.status === item.cursorStatus
    && Number(cursor.backlog_remaining) === (item.input.backlogRemaining ? 1 : 0)
    && (cursor.last_error ?? null) === (item.input.error?.slice(0, 1000) ?? null)
}

async function runPolicy(
  env: Bindings,
  opsDb: D1Database,
  policyId: RetentionHotWindowDrainPolicyId,
  businessDate: string,
  limit: number,
  dryRun: boolean,
  pilot: PilotDays | null,
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
  const blockedDatasets: string[] = []

  // Ledger writes are lazy: a pass that archives nothing and changes no cursor writes no OPS row,
  // except one compact heartbeat a UTC day (readiness wants a drain cursor updated within 2 days;
  // the storage-health closure wants a drain run within 7 days).
  const cursors = dryRun ? new Map<string, CursorState>() : await loadPolicyCursors(opsDb, policyId)
  let runStarted = false
  const startRun = async () => {
    if (dryRun || runStarted) return
    await beginRetentionRun(opsDb, { runId, policyId, businessDate })
    runStarted = true
  }
  const deferred: DeferredCheckpoint[] = []

  const drainSources = config.sources.filter(source => source.deleteTable && source.deleteKeyColumn)
  for (const source of config.sources.filter(source => !source.deleteTable || !source.deleteKeyColumn)) {
    const message = `cold_reader_not_verified:${source.datasetId}`
    blockedDatasets.push(source.datasetId)
    datasets.push({ dataset_id: source.datasetId, source_domain: source.sourceDomain,
      cutoff_date: cutoffDate, candidates: 0, archived_rows: 0, deleted_rows: 0,
      archived_bytes: 0, artifact_id: null, checksum: null, backlog_remaining: true,
      status: 'blocked', error: message })
    if (!dryRun) deferred.push({ blocked: true, cursorStatus: 'running', input: {
      runId, policyId, datasetId: `hot-drain:${source.datasetId}`, status: 'skipped',
      backlogRemaining: true, error: message,
      evidence: { delete_executor: false, candidate_count_known: false, dry_run: false, blocked: true, reason: message },
    } })
  }
  for (const configured of drainSources) {
    const floorCutoff = retentionHotDrainCutoff(businessDate, Number(policy.hot_retention_days), configured.datasetId)
    const sourceDb = retentionSourceDatabase(env, configured.sourceDomain)
    // Set between the R2 archive write and a committed delete; a failure in between leaves an orphan.
    let unreleased: { artifact_id: string; checksum: string } | null = null
    try {
      const sourceCutoff = pilot
        ? await pilotCutoff(sourceDb, retentionSourceAtCutoff(configured, floorCutoff), floorCutoff, pilot) : floorCutoff
      const source = retentionSourceAtCutoff(configured, sourceCutoff)
      const reconciliation = dryRun ? null : await reconcileRetentionReleases(env, sourceDb, source, policyId)
      if (!dryRun) await retireRecentUnreleasedArchives(env, sourceDb, source, policyId)
      const candidates = await loadCandidates(sourceDb, source, sourceCutoff, limit)
      const rows = candidates.rows
      const hasMore = candidates.hasMore || Boolean(reconciliation?.backlog_remaining)
        || (pilot != null && await rowsRemainBefore(sourceDb, source, sourceCutoff, floorCutoff))
      scannedRows += rows.length
      if (dryRun) {
        datasets.push({
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          cutoff_date: sourceCutoff,
          candidates: rows.length,
          archived_rows: 0,
          deleted_rows: 0,
          archived_bytes: 0,
          artifact_id: null,
          checksum: null,
          backlog_remaining: hasMore,
          status: 'dry_run',
        })
        continue
      }
      if (!rows.length) {
        datasets.push({
          dataset_id: source.datasetId,
          source_domain: source.sourceDomain,
          cutoff_date: sourceCutoff,
          candidates: 0,
          archived_rows: 0,
          deleted_rows: 0,
          archived_bytes: 0,
          artifact_id: null,
          checksum: null,
          backlog_remaining: hasMore,
          status: 'skipped',
        })
        deferred.push({ blocked: false, cursorStatus: hasMore ? 'running' : 'cycle_complete', input: {
          runId,
          policyId,
          datasetId: `hot-drain:${source.datasetId}`,
          status: 'skipped',
          deletedRows: 0,
          backlogRemaining: hasMore,
          cycleComplete: !hasMore,
          evidence: {
            schema_version: 'd1-retention-hot-window-drain-v1',
            delete_executor: true,
            dry_run: false,
            cutoff_date: sourceCutoff,
            reason: 'no_eligible_rows',
          },
        } })
        continue
      }

      const first = rows[0]
      const last = rows[rows.length - 1]
      const schema = await sourceDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .bind(source.deleteTable).first<{ sql: string }>()
      if (!schema?.sql) throw new Error(`retention_restore_schema_missing:${source.datasetId}`)
      if (new TextEncoder().encode(JSON.stringify({ rows, source_schema_sql: schema.sql })).length > 7 * 1024 * 1024)
        throw new Error(`retention_archive_envelope_too_large:${source.datasetId}`)
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
          cutoff_date: sourceCutoff,
          hot_retention_days: Number(policy.hot_retention_days),
          cold_retention_days: Number(policy.cold_retention_days),
          source_schema_sql: schema.sql,
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
          restore_schema_version: 'sqlite-exact-rows-v1',
          ...(source.sourceDomain === 'market' && ['stock_prices', 'technical_indicators', 'chip_data', 'margin_data', 'canonical_fundamental_features'].includes(source.datasetId)
            ? { stock_keys: [...new Set(rows.map(row => row[source.datasetId === 'chip_data' ? 'symbol' : 'stock_id']))] } : {}),
          // Cold predictions readers skip chunks by stock and by generated_at (latest-N reads).
          ...(source.sourceDomain === 'learning' && source.datasetId === 'predictions' ? predictionArchiveKeys(rows) : {}),
          coverage_start: first.__archive_date,
          coverage_end: last.__archive_date,
          ...(source.datasetId === 's12_replay_trade_outcomes' ? retentionReplayClockMetadata(rows) : {}),
          exact_row_key_recheck: true,
          delete_executor: true,
          dry_run: false,
        },
      })
      const compact = source.sourceDomain === 'learning' && source.datasetId === 's12_replay_trade_outcomes'
        ? await prepareReplayReleaseProjection(env, rows, artifact) : undefined
      unreleased = { artifact_id: artifact.artifact_id, checksum: artifact.checksum }
      const deleted = await deleteVerifiedRows(sourceDb, source, sourceCutoff, rows, artifact, compact)
      unreleased = null
      const backlogRemaining = hasMore
      archivedRows += rows.length
      deletedRows += deleted
      await startRun()
      const archiveBytes = Number(artifact.byte_size) + Number(compact?.projection.byte_size ?? 0)
      archivedBytes += archiveBytes
      datasets.push({
        dataset_id: source.datasetId,
        source_domain: source.sourceDomain,
        cutoff_date: sourceCutoff,
        candidates: rows.length,
        archived_rows: rows.length,
        deleted_rows: deleted,
        archived_bytes: archiveBytes,
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
        archivedBytes: archiveBytes,
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
          ...(pilot ? { pilot_one_day: true, floor_cutoff_date: floorCutoff } : {}),
          ...(compact ? {projection_artifact_id:compact.projection.artifact_id,projection_checksum:compact.projection.checksum,
            projection_bytes:compact.projection.byte_size} : {}),
          cutoff_date: sourceCutoff,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${configured.datasetId}:${message}`)
      const orphan = unreleased && !dryRun
        ? await retireUnreleasedArchive(env, sourceDb, configured, policyId, unreleased.artifact_id).catch(() => 'retire_failed')
        : null
      datasets.push({
        dataset_id: configured.datasetId,
        source_domain: configured.sourceDomain,
        cutoff_date: floorCutoff,
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
        await startRun()
        await checkpointRetentionItem(opsDb, {
          runId,
          policyId,
          datasetId: `hot-drain:${configured.datasetId}`,
          status: 'error',
          deletedRows: 0,
          backlogRemaining: true,
          error: message,
          evidence: {
            schema_version: 'd1-retention-hot-window-drain-v1',
            delete_executor: true,
            dry_run: false,
            cutoff_date: floorCutoff,
            // The next pass retires this archive if it is still unreleased (retireRecentUnreleasedArchives).
            ...(unreleased ? { artifact_id: unreleased.artifact_id, checksum: unreleased.checksum, orphan } : {}),
          },
        })
      }
    }
  }

  if (!dryRun) {
    const changed = deferred.filter((item) => !cursorUnchanged(cursors, item))
    // updated_at is the ops database's UTC CURRENT_TIMESTAMP, so the day is compared there too.
    const heartbeatDue = deferred.some((item) => !item.blocked
      && Number(cursors.get(item.input.datasetId)?.updated_today ?? 0) !== 1)
    if (changed.length || heartbeatDue) await startRun()
    if (runStarted) {
      const quietBlocked = deferred.filter((item) => item.blocked && cursorUnchanged(cursors, item))
      for (const item of deferred) if (!quietBlocked.includes(item)) await checkpointRetentionItem(opsDb, item.input)
      // Unchanged blocked sources share one item (it keeps their backlog visible to the closure
      // check) and leave their cursors as they are.
      if (quietBlocked.length) await checkpointRetentionItem(opsDb, {
        runId, policyId, datasetId: 'hot-drain:blocked-sources', status: 'skipped', backlogRemaining: true,
        preserveCursor: true,
        evidence: { delete_executor: false, dry_run: false, blocked: true, reason: 'cold_reader_not_verified_unchanged',
          datasets: quietBlocked.map((item) => item.input.datasetId.replace(/^hot-drain:/, '')) },
      })
    }
  }
  if (runStarted) {
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
    status: errors.length ? 'error' : dryRun ? 'dry_run' : 'success',
    cutoff_date: cutoffDate,
    scanned_rows: scannedRows,
    archived_rows: archivedRows,
    deleted_rows: deletedRows,
    archived_bytes: archivedBytes,
    backlog_remaining: datasets.some((item) => item.backlog_remaining),
    blocked_datasets: blockedDatasets,
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
    maxRounds?: number
    budgetMs?: number
    confirmPhrase?: string | null
    /**
     * Drain only the oldest eligible day of each source; needs exactly one explicit policy.
     * L-2 go-live (predictions): learning migration 0073 (cold stats) and ops migration 0029
     * (generated_at manifest index) before the Worker deploy (the weekly no-lookahead audit reads
     * prediction_cold_stats_v1); then repeat
     * `pilot=one_day&policies=learning_lineage_v1&confirm_drain=...` (manual trigger, outside the
     * LEARNING_DB quiet windows) until the summed `archived_bytes` reaches >= 20 MB; compare
     * `wrangler d1 info` size before / after to calibrate reclaim per archived MB; only then enable
     * the retention-hot-window-drain-predictions scheduler job.
     */
    pilotOneDay?: boolean
  } = {},
) {
  if (!env.ARTIFACTS) throw new Error('retention_hot_drain_r2_binding_missing')
  const businessDate = normalizeBusinessDate(options.businessDate)
  const settings = retentionHotDrainSettings(env)
  const limit = Math.max(1, Math.min(Math.floor(options.limitPerDataset ?? settings.limitPerDataset.default),
    settings.limitPerDataset.max))
  const dryRun = options.confirmPhrase !== RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE
  const policyIds = [...new Set(options.policyIds ?? RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS)]
  const allowed = new Set<string>(RETENTION_HOT_WINDOW_DRAIN_POLICY_IDS)
  const unknown = policyIds.filter((policyId) => !allowed.has(policyId))
  if (unknown.length) throw new Error(`retention_hot_drain_policy_not_allowed:${unknown.join(',')}`)
  if (options.pilotOneDay && (options.policyIds?.length !== 1 || policyIds.length !== 1))
    throw new Error('retention_hot_drain_pilot_requires_one_policy')
  const pilot: PilotDays | null = options.pilotOneDay ? new Map() : null
  const opsDb = databaseForDataDomain(env, 'ops')
  const rounds = await runRetentionDrainRounds({
    policyIds, dryRun,
    maxRounds: options.maxRounds ?? settings.maxRounds.default, roundsCap: settings.maxRounds.max,
    budgetMs: options.budgetMs ?? settings.budgetMs.default, budgetCapMs: settings.budgetMs.max,
    run: policyId => runPolicy(env, opsDb, policyId as RetentionHotWindowDrainPolicyId, businessDate, limit, dryRun, pilot),
  })
  const policies = rounds.latest
  const failed = policies.filter((policy) => policy.status === 'error')
  return {
    schema_version: 'retention-hot-window-drain-v1' as const,
    status: failed.length ? 'error' as const : dryRun ? 'dry_run' as const : 'success' as const,
    business_date: businessDate,
    dry_run: dryRun,
    pilot_one_day: pilot != null,
    delete_executor: true,
    policy_count: policyIds.length,
    policy_attempts: rounds.attempts.length,
    complete: !dryRun && rounds.pendingPolicyIds.length === 0,
    stop_reason: rounds.stopReason,
    elapsed_ms: rounds.elapsedMs,
    unstarted_policies: rounds.unstartedPolicyIds,
    pending_policies: rounds.pendingPolicyIds,
    failed_policies: failed.map((policy) => policy.policy_id),
    scanned_rows: rounds.attempts.reduce((sum, policy) => sum + policy.scanned_rows, 0),
    archived_rows: rounds.attempts.reduce((sum, policy) => sum + policy.archived_rows, 0),
    deleted_rows: rounds.attempts.reduce((sum, policy) => sum + policy.deleted_rows, 0),
    archived_bytes: rounds.attempts.reduce((sum, policy) => sum + policy.archived_bytes, 0),
    backlog_remaining: rounds.pendingPolicyIds.length > 0,
    blocked_datasets: [...new Set(policies.flatMap((policy) =>
      policy.blocked_datasets.map((dataset) => `${policy.policy_id}:${dataset}`)))],
    policies,
  }
}

export function summarizeRetentionHotWindowDrain(
  result: Awaited<ReturnType<typeof runRetentionHotWindowDrain>>,
): string {
  return [
    `retention_hot_window_drain status=${result.status}`,
    `dry_run=${result.dry_run}`,
    ...(result.pilot_one_day ? ['pilot_one_day=true'] : []),
    `policies=${result.policy_count}`,
    `attempts=${result.policy_attempts} stop=${result.stop_reason}`,
    `pending=${result.pending_policies.join(',') || 'none'}`,
    `scanned=${result.scanned_rows}`,
    `archived=${result.archived_rows}`,
    `deleted=${result.deleted_rows}`,
    // Pilot calibration sums this across calls (L-2 go-live: pilot until >= 20 MB, then d1 info).
    `archived_bytes=${result.archived_bytes}`,
    `backlog=${result.backlog_remaining}`,
    `failed=${result.failed_policies.join(',') || 'none'}`,
    `blocked=${result.blocked_datasets.length}`,
  ].join(' ')
}
