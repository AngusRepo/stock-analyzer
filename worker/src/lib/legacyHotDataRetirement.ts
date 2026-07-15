import type { Bindings } from '../types'
import { releaseArtifactHardReferencesByOwner, writeEvidenceArtifact } from './artifactLifecycle'

export type LegacyHotDataTarget =
  | 'obsolete_screener_items'
  | 'superseded_pending_items'
  | 'superseded_pending_events'
  | 'null_date_predictions'
  | 'intraday_report_manifests'
  | 'retired_state_space_shadow'
  | 'allocator_snapshot_staging_orphans'

export const LEGACY_HOT_DATA_RETIREMENT_CONFIRM_PHRASE = 'RETIRE_VERIFIED_LEGACY_HOT_DATA'

type RetirementResult = {
  target: LegacyHotDataTarget
  candidates: number
  archived: number
  deleted: number
  artifacts: number
  backlog_remaining: boolean
  dry_run: boolean
}

const TARGETS: LegacyHotDataTarget[] = [
  'obsolete_screener_items',
  'superseded_pending_items',
  'superseded_pending_events',
  'null_date_predictions',
  'intraday_report_manifests',
  'retired_state_space_shadow',
  'allocator_snapshot_staging_orphans',
]

function cleanPart(value: unknown): string {
  return String(value ?? '').replace(/[^A-Za-z0-9_.=-]+/g, '_').slice(0, 120)
}

function twBusinessDate(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function archiveRows(input: {
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>
  target: LegacyHotDataTarget
  businessDate: string
  rows: Record<string, unknown>[]
  firstKey: unknown
  lastKey: unknown
  metadata?: Record<string, unknown>
}) {
  return writeEvidenceArtifact(input.env, {
    domain: `legacy_hot_retirement_${input.target}`,
    businessDate: input.businessDate,
    producerRunId: `legacy-hot-retirement:${input.target}:${cleanPart(input.firstKey)}:${cleanPart(input.lastKey)}`,
    retentionClass: 'superseded_run',
    schemaVersion: 'legacy-hot-data-retirement-v1',
    payload: {
      target: input.target,
      source_rows_preserved: true,
      rows: input.rows,
    },
    rowCount: input.rows.length,
    metadata: {
      destructive_step_requires_verified_artifact: true,
      ...(input.metadata ?? {}),
    },
  })
}

async function deleteByKeys(
  db: D1Database,
  table: string,
  keyColumn: string,
  keys: unknown[],
): Promise<number> {
  let deleted = 0
  for (let offset = 0; offset < keys.length; offset += 40) {
    const chunk = keys.slice(offset, offset + 40)
    const result = await db.prepare(`
      DELETE FROM ${table}
       WHERE ${keyColumn} IN (${chunk.map(() => '?').join(',')})
    `).bind(...chunk).run()
    deleted += Number(result.meta?.changes ?? chunk.length)
  }
  return deleted
}

async function retireObsoleteScreenerItems(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  limit: number,
  dryRun: boolean,
): Promise<RetirementResult> {
  const run = await env.DB.prepare(`
    SELECT r.*
      FROM screener_funnel_runs r
     WHERE NOT EXISTS (
       SELECT 1 FROM canonical_run_heads h WHERE h.run_id=r.run_id
     )
       AND r.run_id <> COALESCE((
         SELECT latest.run_id
           FROM screener_funnel_runs latest
          WHERE latest.date=r.date AND latest.status='success'
          ORDER BY latest.created_at DESC
          LIMIT 1
       ), '')
     ORDER BY r.date ASC, r.created_at ASC, r.run_id ASC
     LIMIT 1
  `).first<Record<string, unknown>>()
  if (!run?.run_id) {
    return { target: 'obsolete_screener_items', candidates: 0, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: false, dry_run: dryRun }
  }
  const runId = String(run.run_id)
  const { results } = await env.DB.prepare(`
    SELECT * FROM screener_funnel_items WHERE run_id=? ORDER BY id ASC LIMIT ?
  `).bind(runId, limit).all<Record<string, unknown>>()
  const rows = results ?? []
  if (rows.length) {
    if (dryRun) {
      return { target: 'obsolete_screener_items', candidates: rows.length, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: true, dry_run: true }
    }
    await archiveRows({
      env,
      target: 'obsolete_screener_items',
      businessDate: String(run.date),
      rows,
      firstKey: rows[0].id,
      lastKey: rows[rows.length - 1].id,
      metadata: { source_run: run },
    })
    const deleted = await deleteByKeys(env.DB, 'screener_funnel_items', 'id', rows.map((row) => row.id))
    return {
      target: 'obsolete_screener_items',
      candidates: rows.length,
      archived: rows.length,
      deleted,
      artifacts: 1,
      backlog_remaining: true,
      dry_run: false,
    }
  }

  if (dryRun) {
    return { target: 'obsolete_screener_items', candidates: 1, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: true, dry_run: true }
  }

  await archiveRows({
    env,
    target: 'obsolete_screener_items',
    businessDate: String(run.date),
    rows: [run],
    firstKey: runId,
    lastKey: 'run-final',
    metadata: { run_manifest_only: true, item_backlog_drained: true },
  })
  await releaseArtifactHardReferencesByOwner(env.DB, {
    ownerType: 'legacy_screener_run',
    ownerId: runId,
  })
  const deleted = await deleteByKeys(env.DB, 'screener_funnel_runs', 'run_id', [runId])
  return {
    target: 'obsolete_screener_items',
    candidates: 1,
    archived: 1,
    deleted,
    artifacts: 1,
    backlog_remaining: true,
    dry_run: false,
  }
}

async function retireAllocatorSnapshotStagingOrphans(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  limit: number,
  dryRun: boolean,
): Promise<RetirementResult> {
  const run = await env.DB.prepare(`
    SELECT *
      FROM allocator_ev_snapshot_runs
     WHERE status IN ('writing','failed')
       AND updated_at < datetime('now','-7 days')
     ORDER BY updated_at ASC, run_id ASC
     LIMIT 1
  `).first<Record<string, unknown>>()
  if (!run?.run_id) {
    return { target: 'allocator_snapshot_staging_orphans', candidates: 0, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: false, dry_run: dryRun }
  }
  const runId = String(run.run_id)
  const { results } = await env.DB.prepare(`
    SELECT rowid AS staging_rowid, *
      FROM allocator_ev_feature_snapshot_staging
     WHERE run_id=?
     ORDER BY stock_id ASC
     LIMIT ?
  `).bind(runId, limit).all<Record<string, unknown>>()
  const rows = results ?? []
  if (rows.length) {
    if (dryRun) {
      return { target: 'allocator_snapshot_staging_orphans', candidates: rows.length, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: true, dry_run: true }
    }
    await archiveRows({
      env,
      target: 'allocator_snapshot_staging_orphans',
      businessDate: String(run.snapshot_date),
      rows,
      firstKey: rows[0].staging_rowid,
      lastKey: rows[rows.length - 1].staging_rowid,
      metadata: { source_run: run, staging_only: true },
    })
    const deleted = await deleteByKeys(
      env.DB,
      'allocator_ev_feature_snapshot_staging',
      'rowid',
      rows.map((row) => row.staging_rowid),
    )
    return {
      target: 'allocator_snapshot_staging_orphans',
      candidates: rows.length,
      archived: rows.length,
      deleted,
      artifacts: 1,
      backlog_remaining: true,
      dry_run: false,
    }
  }
  if (dryRun) {
    return { target: 'allocator_snapshot_staging_orphans', candidates: 1, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: true, dry_run: true }
  }
  await archiveRows({
    env,
    target: 'allocator_snapshot_staging_orphans',
    businessDate: String(run.snapshot_date),
    rows: [run],
    firstKey: runId,
    lastKey: 'run-final',
    metadata: { run_manifest_only: true, staging_backlog_drained: true },
  })
  const deleted = await deleteByKeys(env.DB, 'allocator_ev_snapshot_runs', 'run_id', [runId])
  return {
    target: 'allocator_snapshot_staging_orphans',
    candidates: 1,
    archived: 1,
    deleted,
    artifacts: 1,
    backlog_remaining: true,
    dry_run: false,
  }
}

async function retireSimpleTarget(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  input: {
    target: Exclude<LegacyHotDataTarget, 'obsolete_screener_items'>
    table: string
    keyColumn: string
    businessDate: string
    query: string
    limit: number
    dryRun: boolean
    metadata?: Record<string, unknown>
  },
): Promise<RetirementResult> {
  const { results } = await env.DB.prepare(input.query).bind(input.limit).all<Record<string, unknown>>()
  const rows = results ?? []
  if (!rows.length) {
    return { target: input.target, candidates: 0, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: false, dry_run: input.dryRun }
  }
  if (input.dryRun) {
    return { target: input.target, candidates: rows.length, archived: 0, deleted: 0, artifacts: 0, backlog_remaining: true, dry_run: true }
  }
  const keys = rows.map((row) => row[input.keyColumn])
  await archiveRows({
    env,
    target: input.target,
    businessDate: input.businessDate,
    rows,
    firstKey: keys[0],
    lastKey: keys[keys.length - 1],
    metadata: input.metadata,
  })
  const deleted = await deleteByKeys(env.DB, input.table, input.keyColumn, keys)
  return {
    target: input.target,
    candidates: rows.length,
    archived: rows.length,
    deleted,
    artifacts: 1,
    backlog_remaining: rows.length === input.limit,
    dry_run: false,
  }
}

export async function runLegacyHotDataRetirement(
  env: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  options: { target: LegacyHotDataTarget; limit?: number; businessDate?: string; dryRun?: boolean } ,
): Promise<RetirementResult> {
  if (!env.ARTIFACTS) throw new Error('artifact_r2_binding_missing')
  if (!TARGETS.includes(options.target)) throw new Error(`unsupported_legacy_hot_data_target:${options.target}`)
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 250), 500))
  const businessDate = options.businessDate ?? twBusinessDate()
  const dryRun = options.dryRun !== false

  if (options.target === 'obsolete_screener_items') {
    return retireObsoleteScreenerItems(env, limit, dryRun)
  }
  if (options.target === 'allocator_snapshot_staging_orphans') {
    return retireAllocatorSnapshotStagingOrphans(env, limit, dryRun)
  }
  if (options.target === 'superseded_pending_items') {
    return retireSimpleTarget(env, {
      target: options.target,
      table: 'pending_buy_items',
      keyColumn: 'id',
      businessDate,
      limit,
      dryRun,
      query: `
        SELECT i.*, r.trade_date, r.source_reco_date, r.status AS run_status,
               r.debate_status AS run_debate_status, r.created_at AS run_created_at
          FROM pending_buy_items i
          JOIN pending_buy_runs r ON r.id=i.run_id
         WHERE r.status='superseded'
         ORDER BY r.trade_date ASC, i.id ASC
         LIMIT ?
      `,
      metadata: { protected_execution_ledgers_deleted: false },
    })
  }
  if (options.target === 'superseded_pending_events') {
    return retireSimpleTarget(env, {
      target: options.target,
      table: 'paper_execution_events',
      keyColumn: 'id',
      businessDate,
      limit,
      dryRun,
      query: `
        SELECT e.*
          FROM paper_execution_events e
          JOIN pending_buy_runs r ON r.id=e.pending_run_id
         WHERE r.status='superseded'
           AND e.event_type IN ('pending_buy','debate','snapshot_audit','finlab_preview','finlab_execution_preview')
         ORDER BY e.trade_date ASC, e.id ASC
         LIMIT ?
      `,
      metadata: {
        preserved_event_types: [
          'paper_order', 'paper_position_update', 'paper_broker_reconciliation',
          'live_execution_shadow', 'intraday_technical_decision', 's12_intraday_structure',
        ],
      },
    })
  }
  if (options.target === 'null_date_predictions') {
    return retireSimpleTarget(env, {
      target: options.target,
      table: 'predictions',
      keyColumn: 'id',
      businessDate: 'undated',
      limit,
      dryRun,
      query: `SELECT * FROM predictions WHERE prediction_date IS NULL ORDER BY id ASC LIMIT ?`,
      metadata: {
        prediction_date_inference_forbidden: true,
        generated_at_is_not_business_date: true,
      },
    })
  }
  if (options.target === 'intraday_report_manifests') {
    return retireSimpleTarget(env, {
      target: options.target,
      table: 'dataset_snapshots',
      keyColumn: 'snapshot_id',
      businessDate,
      limit,
      dryRun,
      query: `
        SELECT * FROM dataset_snapshots
         WHERE kind='intraday_check_run_report' AND status='ready' AND r2_key IS NOT NULL
         ORDER BY business_date ASC, snapshot_id ASC
         LIMIT ?
      `,
      metadata: { reader_contract: 'none', source_r2_objects_preserved: true },
    })
  }
  return retireSimpleTarget(env, {
    target: options.target,
    table: 'state_space_shadow_results',
    keyColumn: 'id',
    businessDate,
    limit,
    dryRun,
    query: `
      SELECT * FROM state_space_shadow_results
       WHERE run_date < date('now', '-30 days')
       ORDER BY run_date ASC, id ASC
       LIMIT ?
    `,
    metadata: { retention_days: 30, serving_reader_contract: 'none' },
  })
}
