import type { RetentionArchiveSource } from './retentionArchiveOnly'

// D1-M3: which archive-only learning_lineage_v1 datasets may drain, with what hot window and
// eligibility. retentionArchiveOnly.ts keeps every dataset archive-only (no deleteTable) for the
// 15-minute archive-only job; the hot-window drain overlays these specs only when the OPS row in
// data_retention_dataset_gates is active (ops migration 0025, Wei go per dataset). The gate row
// must also repeat the hot window written here, so code and policy cannot silently disagree.

export const LEARNING_DRAIN_POLICY_ID = 'learning_lineage_v1' as const

export type LearningDrainSpec = {
  dataset: string
  dateColumn: string
  hotRetentionDays: number
  eligibilitySql: string
  // Natural identity of a row: the cold reader lets a hot row with the same key win.
  identityKeys: readonly (readonly string[])[]
  // Set while a prerequisite outside this module is missing; the gate alone cannot enable it.
  codeBlockedReason?: string
}

// NEW-Q14 plan B (Wei 10/28): live paper writers keep these sources hot forever.
// s12_intraday_structure_v1 is the writer default label (s12StructureSnapshots.ts:81/165).
export const S12_STRUCTURE_LIVE_SOURCES = ['s12_intraday_structure', 's12_holding_defense', 's12_intraday_structure_v1'] as const

// Unary + keeps the planner off idx_dataset_snapshots_access_date (a MULTI-INDEX OR that sorts the
// whole tier backlog every round) and on the partial index of learning migration 0068, whose WHERE is
// this text without the table prefix (test-enforced).
const DATASET_SNAPSHOT_ELIGIBILITY = `dataset_snapshots.status IN ('ready','failed','expired') AND (
  (+dataset_snapshots.access_tier='report' AND dataset_snapshots.primary_store='r2'
    AND dataset_snapshots.kind LIKE '%!_run!_report' ESCAPE '!')
  OR (+dataset_snapshots.access_tier='serving' AND dataset_snapshots.primary_store='d1'
    AND dataset_snapshots.kind LIKE '%!_hot!_window' ESCAPE '!'))`

const M2_BLOCK = 'm2_write_contract_and_long_lookback_readers_required'

export const LEARNING_DRAIN_SPECS: Readonly<Record<string, LearningDrainSpec>> = {
  dataset_snapshots: {
    dataset: 'dataset_snapshots', dateColumn: 'business_date', hotRetentionDays: 120,
    // d1_audit_json_archive / d1_cold_archive pointers and compute snapshots are live indexes.
    eligibilitySql: DATASET_SNAPSHOT_ELIGIBILITY,
    identityKeys: [['snapshot_id']],
  },
  s12_replay_trade_outcomes: {
    dataset: 's12_replay_trade_outcomes', dateColumn: 'trade_date', hotRetentionDays: 120,
    eligibilitySql: '1=1',
    identityKeys: [['id'], ['symbol', 'trade_date', 'setup_id'], ['symbol', 'signal_date', 'setup_id']],
    // Python readers (allocator_ev_fusion_artifact_builder.py, routers/optuna.py, opb prior) read only
    // the hot table; deleting would silently shrink their samples. Lift after Wei picks cold merge or retirement.
    codeBlockedReason: 's12_python_readers_cold_merge_required',
  },
  s12_structure_snapshots: {
    dataset: 's12_structure_snapshots', dateColumn: 'trade_date', hotRetentionDays: 120,
    // Same text (without the table prefix) as the partial index WHERE of learning migration 0068, so
    // live rows that stay hot forever are never re-read by the drain.
    eligibilitySql: `s12_structure_snapshots.source NOT IN (${S12_STRUCTURE_LIVE_SOURCES.map(s => `'${s}'`).join(',')})`,
    identityKeys: [['id'], ['trade_date', 'symbol', 'source']],
  },
  strategy_decision_log: {
    dataset: 'strategy_decision_log', dateColumn: 'date', hotRetentionDays: 45,
    eligibilitySql: '1=1',
    identityKeys: [['decision_id'], ['date', 'symbol', 'strategy_id', 'strategy_version']],
    codeBlockedReason: M2_BLOCK,
  },
  strategy_label_matrix_v4: {
    dataset: 'strategy_label_matrix_v4', dateColumn: 'signal_date', hotRetentionDays: 45,
    eligibilitySql: '1=1',
    identityKeys: [['signal_date', 'symbol', 'producer_run_id', 'strategy_id', 'strategy_version']],
    codeBlockedReason: M2_BLOCK,
  },
}

// Cold-readable datasets of learning_lineage_v1 (predictions drains through tableSource).
export const LEARNING_COLD_IDENTITY: Readonly<Record<string, { dateColumn: string; identityKeys: readonly (readonly string[])[] }>> = {
  predictions: { dateColumn: 'prediction_date', identityKeys: [['id']] },
  ...Object.fromEntries(Object.values(LEARNING_DRAIN_SPECS).map(spec =>
    [spec.dataset, { dateColumn: spec.dateColumn, identityKeys: spec.identityKeys }])),
}

export type LearningDrainGate = {
  dataset_id: string
  hot_retention_days: number
  action: string
  status: string
}

export async function loadLearningDrainGates(opsDb: D1Database): Promise<Map<string, LearningDrainGate>> {
  // Migration 0025 may not be applied yet: then nothing beyond predictions drains.
  const table = await opsDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .bind('data_retention_dataset_gates').first<{ name: string }>()
  if (!table) return new Map()
  const rows = await opsDb.prepare(`SELECT dataset_id, hot_retention_days, action, status
      FROM data_retention_dataset_gates WHERE policy_id=?`)
    .bind(LEARNING_DRAIN_POLICY_ID).all<LearningDrainGate>()
  return new Map((rows.results ?? []).map(row => [row.dataset_id, row]))
}

/** Hot window a Learning dataset is governed by: its M3 spec, else the policy window. */
export function learningDatasetHotDays(datasetId: string, policyHotDays: number): number {
  return LEARNING_DRAIN_SPECS[datasetId]?.hotRetentionDays ?? policyHotDays
}

export type ResolvedDrainSource = {
  source: RetentionArchiveSource
  hotRetentionDays: number | null
  blockedReason: string | null
}

/** Overlay an active gate onto an archive-only source; every other combination stays blocked. */
export function resolveLearningDrainSource(
  configured: RetentionArchiveSource,
  gates: ReadonlyMap<string, LearningDrainGate>,
): ResolvedDrainSource {
  const spec = LEARNING_DRAIN_SPECS[configured.datasetId]
  // A dataset with an M3 spec always goes through gate + code block + eligibility, even if its
  // archive source ever gains a deleteTable; only spec-less sources (predictions) keep their own config.
  if (!spec) {
    if (configured.deleteTable && configured.deleteKeyColumn)
      return { source: configured, hotRetentionDays: null, blockedReason: null }
    return { source: configured, hotRetentionDays: null, blockedReason: 'no_drain_spec' }
  }
  const gate = gates.get(configured.datasetId)
  if (!gate || gate.status !== 'active' || gate.action !== 'archive_delete')
    return { source: configured, hotRetentionDays: null,
      blockedReason: `gate_${gate ? `${gate.status}_${gate.action}` : 'missing'}` }
  if (Number(gate.hot_retention_days) !== spec.hotRetentionDays)
    return { source: configured, hotRetentionDays: null,
      blockedReason: `gate_hot_window_mismatch_${gate.hot_retention_days}_vs_${spec.hotRetentionDays}` }
  if (spec.codeBlockedReason) return { source: configured, hotRetentionDays: null, blockedReason: spec.codeBlockedReason }
  // The overlay replaces the source eligibility, so the archive source must not carry one of its own.
  if (configured.fromSql !== spec.dataset || configured.dateExpression !== `${spec.dataset}.${spec.dateColumn}`
    || configured.eligibilitySql !== '1=1' || configured.scanEligibilitySql !== undefined)
    return { source: configured, hotRetentionDays: null, blockedReason: 'archive_source_shape_changed' }
  return {
    source: { ...configured, eligibilitySql: spec.eligibilitySql, scanEligibilitySql: undefined,
      deleteTable: spec.dataset, deleteKeyColumn: 'rowid' },
    hotRetentionDays: spec.hotRetentionDays,
    blockedReason: null,
  }
}
