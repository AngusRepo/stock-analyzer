import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { listStrategyEvidenceProfiles } from './strategyEvidenceProfile'
import { listStrategySpecsForLearning } from './strategyLearning'
import { STRATEGY_FORMAL_LABELER_VERSIONS } from './strategySpec'

export const STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION = 'strategy-evidence-owner-calibration-v1' as const
export const STRATEGY_EVIDENCE_OWNER_CHALLENGER_VERSION = 'strategy-evidence-owner-fusion-v2-oos-challenger' as const
export const STRATEGY_EVIDENCE_OWNER_MIN_TOTAL_DATES = 8
export const STRATEGY_EVIDENCE_OWNER_MIN_TRAIN_DATES = 3
export const STRATEGY_EVIDENCE_OWNER_PURGE_DATES = 2
export const STRATEGY_EVIDENCE_OWNER_MIN_OOS_DATES = 3
export const STRATEGY_EVIDENCE_OWNER_MIN_ACTIVE_STRATEGIES = 3
export const STRATEGY_EVIDENCE_OWNER_MIN_COVERAGE = 0.20
const REFERENCE_CONTRACT = 'selection-reference-snapshot-v3'

export type StrategyEvidenceCalibrationMetricRow = {
  strategy_id: string
  strategy_version: string
  primary_horizon_days: number | string
  metric_name: string
  metric_value: number | string | null
  metric_status: string
  outcome_as_of_date: string
  definition_version: string
}

export type StrategyEvidenceCalibrationProfile = {
  strategy_id: string
  strategy_version: string
  strategy_status: string
  primary_horizon_days: number
  required_metrics: readonly string[]
}

export type StrategyEvidenceDateReturn = {
  signal_date: string
  strategy_id: string
  strategy_version: string
  residual_return_net: number
  sample_count: number
}

export type StrategyEvidenceOwnerCalibrationArtifactRow = {
  strategy_id: string
  strategy_version: string
  metric_outcome_as_of_date: string
  multi_horizon_score: number | null
  weight_multiplier: number
  source_metric_checksum: string
  payload_checksum: string
}

export type StrategyEvidenceOwnerCalibrationResult = {
  status: 'pending_maturity' | 'rejected' | 'approved' | 'promoted'
  sourceSnapshotCount: number
  sourceSnapshotChecksum: string
  historyChecksum: string
  sampleCount: number
  dateCount: number
  trainDates: string[]
  purgeDates: string[]
  oosDates: string[]
  baselineReturn: number | null
  challengerReturn: number | null
  challengerDelta: number | null
  challengerDeltaLcb90: number | null
  coverage: number
  gates: Record<string, boolean>
  artifacts: StrategyEvidenceOwnerCalibrationArtifactRow[]
  artifactChecksum: string
}

export type PromotedStrategyEvidenceOwnerCalibration = {
  runId: string
  artifactChecksum: string
  sourceMetricChecksum: string
  knowledgeCutoffDate: string
  artifacts: StrategyEvidenceOwnerCalibrationArtifactRow[]
}

function finite(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function round6(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(6))
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function lcb90(values: number[]): number | null {
  if (values.length < 2) return null
  const average = mean(values)!
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  return round6(average - 1.281551565545 * Math.sqrt(Math.max(0, variance) / values.length))
}

async function sha256(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function calibrationMetricSnapshotChecksum(
  rows: readonly StrategyEvidenceCalibrationMetricRow[],
): Promise<string> {
  const canonical = [...rows].sort((left, right) => (
    `${left.strategy_id}|${left.strategy_version}|${Number(left.primary_horizon_days)}|${left.metric_name}`
      .localeCompare(`${right.strategy_id}|${right.strategy_version}|${Number(right.primary_horizon_days)}|${right.metric_name}`)
  )).map((row) => [
    row.strategy_id,
    row.strategy_version,
    Number(row.primary_horizon_days),
    row.metric_name,
    finite(row.metric_value),
    row.metric_status,
    row.outcome_as_of_date,
    row.definition_version,
  ])
  return sha256(JSON.stringify(canonical))
}

// This is the retired v2 mapping preserved strictly as an OOS challenger.
// Production never evaluates this formula directly; it only consumes a
// checksum-bound promoted calibration artifact.
export function legacyV2CandidateNormalizedMetric(
  metricName: string,
  value: number,
  primaryHorizonDays: number,
): number {
  switch (metricName) {
    case 'residual_return_lcb90': return clamp(Math.tanh(value / 0.02))
    case 'rank_ic': return clamp(Math.tanh(value / 0.10))
    case 'max_drawdown': return clamp((value + 0.08) / 0.08)
    case 'turnover_after_cost': return clamp(Math.tanh(value / 0.05))
    case 'regime_consistency': return clamp(Math.tanh(value / 0.03))
    case 'false_breakout_rate': return clamp((0.50 - value) / 0.25)
    case 'tail_loss_cvar95': return clamp((value + 0.20) / 0.20)
    case 'time_to_reversion': return clamp((primaryHorizonDays - value) / Math.max(primaryHorizonDays, 1))
    case 'maximum_adverse_excursion': return clamp((value + 0.08) / 0.08)
    case 'downside_capture': return clamp(1 - value)
    case 'crowding_decay': return clamp(Math.tanh(value / 0.03))
    case 'fundamental_revision_persistence': return clamp(value)
    default: return 0
  }
}

type CandidateWeight = { score: number | null; multiplier: number }

async function candidateWeightsForSnapshot(
  profiles: readonly StrategyEvidenceCalibrationProfile[],
  rows: readonly StrategyEvidenceCalibrationMetricRow[],
): Promise<{ weights: Map<string, CandidateWeight>; checksum: string }> {
  const byKey = new Map(rows.map((row) => [
    `${row.strategy_id}|${row.strategy_version}|${Number(row.primary_horizon_days)}|${row.metric_name}`,
    row,
  ]))
  const weights = new Map<string, CandidateWeight>()
  for (const profile of profiles) {
    const metrics = profile.required_metrics.map((metricName) => ({
      metricName,
      row: byKey.get(`${profile.strategy_id}|${profile.strategy_version}|${profile.primary_horizon_days}|${metricName}`),
    }))
    const ready = metrics.every(({ row }) => row?.metric_status === 'ready' && finite(row.metric_value) != null)
    const normalized = ready
      ? metrics.map(({ metricName, row }) => legacyV2CandidateNormalizedMetric(
        metricName,
        Number(row!.metric_value),
        profile.primary_horizon_days,
      ))
      : []
    const score = normalized.length ? round6(mean(normalized)) : null
    weights.set(`${profile.strategy_id}|${profile.strategy_version}`, {
      score,
      multiplier: score == null ? 1 : round6(clamp(1 + 0.25 * score, 0.75, 1.25))!,
    })
  }
  return { weights, checksum: await calibrationMetricSnapshotChecksum(rows) }
}

export async function evaluateStrategyEvidenceOwnerCalibration(input: {
  profiles: readonly StrategyEvidenceCalibrationProfile[]
  metricRows: readonly StrategyEvidenceCalibrationMetricRow[]
  dateReturns: readonly StrategyEvidenceDateReturn[]
  allowPromotion?: boolean
}): Promise<StrategyEvidenceOwnerCalibrationResult> {
  const activeProfiles = input.profiles.filter((profile) => profile.strategy_status === 'active')
  const snapshotDates = [...new Set(input.metricRows.map((row) => row.outcome_as_of_date))].sort()
  const snapshots = new Map<string, Awaited<ReturnType<typeof candidateWeightsForSnapshot>>>()
  for (const date of snapshotDates) {
    snapshots.set(date, await candidateWeightsForSnapshot(
      input.profiles,
      input.metricRows.filter((row) => row.outcome_as_of_date === date),
    ))
  }
  const latestSnapshotDate = snapshotDates.at(-1) ?? ''
  const latestSnapshot = snapshots.get(latestSnapshotDate)
  const historyChecksum = await sha256(JSON.stringify(snapshotDates.map((date) => [date, snapshots.get(date)!.checksum])))
  const returnsByDate = new Map<string, StrategyEvidenceDateReturn[]>()
  for (const row of input.dateReturns) {
    returnsByDate.set(row.signal_date, [...(returnsByDate.get(row.signal_date) ?? []), row])
  }
  const evaluatedDates: Array<{ date: string; baseline: number; challenger: number; delta: number; coverage: number; samples: number }> = []
  for (const [date, dateRows] of [...returnsByDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const snapshotDate = snapshotDates.filter((candidate) => candidate < date).at(-1)
    if (!snapshotDate) continue
    const weights = snapshots.get(snapshotDate)!.weights
    const eligible = dateRows.map((row) => ({
      row,
      weight: weights.get(`${row.strategy_id}|${row.strategy_version}`),
    })).filter((item): item is typeof item & { weight: CandidateWeight } => item.weight?.score != null)
    if (eligible.length < STRATEGY_EVIDENCE_OWNER_MIN_ACTIVE_STRATEGIES) continue
    const baseline = mean(eligible.map(({ row }) => row.residual_return_net))!
    const weightSum = eligible.reduce((sum, { weight }) => sum + weight.multiplier, 0)
    if (!(weightSum > 0)) continue
    const challenger = eligible.reduce((sum, { row, weight }) => (
      sum + row.residual_return_net * weight.multiplier
    ), 0) / weightSum
    evaluatedDates.push({
      date,
      baseline,
      challenger,
      delta: challenger - baseline,
      coverage: eligible.length / Math.max(1, activeProfiles.length),
      samples: eligible.reduce((sum, { row }) => sum + row.sample_count, 0),
    })
  }
  const dates = evaluatedDates.map((row) => row.date)
  const oosStart = Math.max(0, dates.length - STRATEGY_EVIDENCE_OWNER_MIN_OOS_DATES)
  const trainEnd = Math.max(0, oosStart - STRATEGY_EVIDENCE_OWNER_PURGE_DATES)
  const trainDates = dates.slice(0, trainEnd)
  const purgeDates = dates.slice(trainEnd, oosStart)
  const oosDates = dates.slice(oosStart)
  const train = evaluatedDates.filter((row) => trainDates.includes(row.date))
  const oos = evaluatedDates.filter((row) => oosDates.includes(row.date))
  const oosDeltas = oos.map((row) => row.delta)
  const coverage = mean(oos.map((row) => row.coverage)) ?? 0
  const latestCalibratedActive = activeProfiles.filter((profile) => (
    latestSnapshot?.weights.get(`${profile.strategy_id}|${profile.strategy_version}`)?.score != null
  )).length
  const gates = {
    enough_total_dates: dates.length >= STRATEGY_EVIDENCE_OWNER_MIN_TOTAL_DATES,
    enough_train_dates: trainDates.length >= STRATEGY_EVIDENCE_OWNER_MIN_TRAIN_DATES,
    purge_gap_complete: purgeDates.length === STRATEGY_EVIDENCE_OWNER_PURGE_DATES,
    enough_oos_dates: oosDates.length >= STRATEGY_EVIDENCE_OWNER_MIN_OOS_DATES,
    enough_active_strategies: latestCalibratedActive >= STRATEGY_EVIDENCE_OWNER_MIN_ACTIVE_STRATEGIES,
    oos_profile_coverage: coverage >= STRATEGY_EVIDENCE_OWNER_MIN_COVERAGE,
    train_delta_non_negative: (mean(train.map((row) => row.delta)) ?? Number.NEGATIVE_INFINITY) >= 0,
    oos_delta_lcb90_positive: (lcb90(oosDeltas) ?? Number.NEGATIVE_INFINITY) > 0,
    oos_challenger_return_above_baseline: (mean(oos.map((row) => row.challenger)) ?? Number.NEGATIVE_INFINITY)
      > (mean(oos.map((row) => row.baseline)) ?? Number.POSITIVE_INFINITY),
  }
  const maturityReady = gates.enough_total_dates && gates.enough_train_dates && gates.purge_gap_complete
    && gates.enough_oos_dates && gates.enough_active_strategies
  const passed = Object.values(gates).every(Boolean)
  const provisionalStatus = !maturityReady ? 'pending_maturity' : passed ? 'approved' : 'rejected'
  const status = provisionalStatus === 'approved' && input.allowPromotion === true ? 'promoted' : provisionalStatus
  const sourceSnapshotChecksum = latestSnapshot?.checksum ?? await sha256('[]')
  const artifactsWithoutChecksum = input.profiles.map((profile) => {
    const weight = latestSnapshot?.weights.get(`${profile.strategy_id}|${profile.strategy_version}`)
    return {
      strategy_id: profile.strategy_id,
      strategy_version: profile.strategy_version,
      metric_outcome_as_of_date: latestSnapshotDate,
      multi_horizon_score: weight?.score ?? null,
      weight_multiplier: weight?.multiplier ?? 1,
      source_metric_checksum: sourceSnapshotChecksum,
    }
  }).sort((left, right) => `${left.strategy_id}|${left.strategy_version}`.localeCompare(`${right.strategy_id}|${right.strategy_version}`))
  const artifacts: StrategyEvidenceOwnerCalibrationArtifactRow[] = []
  for (const row of artifactsWithoutChecksum) {
    artifacts.push({ ...row, payload_checksum: await sha256(JSON.stringify(row)) })
  }
  const artifactChecksum = await sha256(JSON.stringify({
    version: STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION,
    challenger: STRATEGY_EVIDENCE_OWNER_CHALLENGER_VERSION,
    source_snapshot_checksum: sourceSnapshotChecksum,
    history_checksum: historyChecksum,
    artifacts,
  }))
  return {
    status,
    sourceSnapshotCount: snapshotDates.length,
    sourceSnapshotChecksum,
    historyChecksum,
    sampleCount: oos.reduce((sum, row) => sum + row.samples, 0),
    dateCount: dates.length,
    trainDates,
    purgeDates,
    oosDates,
    baselineReturn: round6(mean(oos.map((row) => row.baseline))),
    challengerReturn: round6(mean(oos.map((row) => row.challenger))),
    challengerDelta: round6(mean(oosDeltas)),
    challengerDeltaLcb90: lcb90(oosDeltas),
    coverage: round6(coverage) ?? 0,
    gates,
    artifacts,
    artifactChecksum,
  }
}

async function canonicalRunIdsBefore(db: D1Database, cutoffDate: string): Promise<Record<string, string>> {
  const result = await db.prepare(`
    SELECT logical_run_key, run_id FROM canonical_run_heads
     WHERE logical_run_key GLOB 'screener:????-??-??:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) < ? ORDER BY logical_run_key
  `).bind(cutoffDate).all<{ logical_run_key: string; run_id: string }>()
  return Object.fromEntries((result.results ?? []).map((row) => [
    row.logical_run_key.slice('screener:'.length, 'screener:'.length + 10),
    row.run_id,
  ]))
}

async function loadDateReturns(
  db: D1Database,
  profiles: readonly StrategyEvidenceCalibrationProfile[],
  cutoffDate: string,
  canonicalRunIds: Record<string, string>,
): Promise<StrategyEvidenceDateReturn[]> {
  const output: StrategyEvidenceDateReturn[] = []
  for (const profile of profiles.filter((row) => row.strategy_status === 'active')) {
    const result = await db.prepare(`
      SELECT v.signal_date, AVG(v.residual_return_net) residual_return_net, COUNT(*) sample_count
        FROM strategy_evidence_observations_v1 v
       WHERE v.strategy_id=? AND v.strategy_version=? AND v.horizon_days=?
         AND v.outcome_known_date < ?
         AND EXISTS (
           SELECT 1 FROM selection_reference_snapshots_v1 r
            WHERE r.signal_date=v.signal_date AND r.symbol=v.symbol AND r.producer_run_id=v.producer_run_id
              AND r.strategy_matrix_status='ready' AND r.feature_contract_version=?
              AND r.strategy_labeler_version IN (${STRATEGY_FORMAL_LABELER_VERSIONS.map(() => '?').join(',')})
              AND EXISTS (
                SELECT 1 FROM strategy_label_matrix_runs_v4 mr
                 WHERE mr.producer_run_id=v.producer_run_id AND mr.status='ready'
                   AND mr.expected_cell_count>0 AND mr.persisted_cell_count=mr.expected_cell_count
                   AND mr.labeler_version=r.strategy_labeler_version
                   AND mr.strategy_registry_checksum=r.strategy_registry_checksum
                   AND mr.reference_contract_version=r.feature_contract_version
              )
         )
         AND EXISTS (SELECT 1 FROM json_each(?) h WHERE h.key=v.signal_date AND h.value=v.producer_run_id)
       GROUP BY v.signal_date ORDER BY v.signal_date
    `).bind(
      profile.strategy_id,
      profile.strategy_version,
      profile.primary_horizon_days,
      cutoffDate,
      REFERENCE_CONTRACT,
      ...STRATEGY_FORMAL_LABELER_VERSIONS,
      JSON.stringify(canonicalRunIds),
    ).all<{ signal_date: string; residual_return_net: number | string; sample_count: number | string }>()
    output.push(...(result.results ?? []).map((row) => ({
      signal_date: row.signal_date,
      strategy_id: profile.strategy_id,
      strategy_version: profile.strategy_version,
      residual_return_net: Number(row.residual_return_net),
      sample_count: Number(row.sample_count),
    })))
  }
  return output
}

export async function refreshStrategyEvidenceOwnerCalibration(
  env: Bindings,
  input: { knowledgeCutoffDate: string; allowPromotion?: boolean },
): Promise<{ runId: string; result: StrategyEvidenceOwnerCalibrationResult }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.knowledgeCutoffDate)) {
    throw new Error('invalid_strategy_evidence_owner_calibration_cutoff')
  }
  const db = databaseForDataDomain(env, 'learning')
  const { specs } = await listStrategySpecsForLearning(db, {
    asOfDate: input.knowledgeCutoffDate,
    applyAdaptivePolicy: false,
  })
  const profiles: StrategyEvidenceCalibrationProfile[] = listStrategyEvidenceProfiles(
    specs.filter((spec) => spec.status !== 'retired'),
    { availableOutcomeHorizonDays: [3, 5, 10] },
  ).filter((profile) => profile.strategy_status === 'active' || profile.strategy_status === 'shadow')
  const metricQuery = await db.prepare(`
    SELECT strategy_id, strategy_version, primary_horizon_days, metric_name,
           metric_value, metric_status, outcome_as_of_date, definition_version
      FROM strategy_evidence_metrics_v1
     WHERE outcome_as_of_date < ? AND definition_version='strategy-evidence-metrics-v4'
     ORDER BY outcome_as_of_date, strategy_id, strategy_version, metric_name
  `).bind(input.knowledgeCutoffDate).all<StrategyEvidenceCalibrationMetricRow>()
  const canonical = await canonicalRunIdsBefore(databaseForDataDomain(env, 'ops'), input.knowledgeCutoffDate)
  const dateReturns = await loadDateReturns(db, profiles, input.knowledgeCutoffDate, canonical)
  const result = await evaluateStrategyEvidenceOwnerCalibration({
    profiles,
    metricRows: metricQuery.results ?? [],
    dateReturns,
    allowPromotion: input.allowPromotion,
  })
  const runId = `${STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION}-${input.knowledgeCutoffDate}-${result.artifactChecksum.slice(0, 20)}`
  const statements: D1PreparedStatement[] = [db.prepare(`
    INSERT OR IGNORE INTO strategy_evidence_owner_calibration_runs_v1 (
      run_id, artifact_version, knowledge_cutoff_date, status,
      source_metric_definition_version, source_snapshot_count, source_snapshot_checksum,
      sample_count, date_count, train_dates_json, purge_dates_json, oos_dates_json,
      baseline_return, challenger_return, challenger_delta, challenger_delta_lcb90,
      coverage, gate_json, artifact_checksum
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    runId,
    STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION,
    input.knowledgeCutoffDate,
    result.status,
    'strategy-evidence-metrics-v4',
    result.sourceSnapshotCount,
    result.sourceSnapshotChecksum,
    result.sampleCount,
    result.dateCount,
    JSON.stringify(result.trainDates),
    JSON.stringify(result.purgeDates),
    JSON.stringify(result.oosDates),
    result.baselineReturn,
    result.challengerReturn,
    result.challengerDelta,
    result.challengerDeltaLcb90,
    result.coverage,
    JSON.stringify({ ...result.gates, history_checksum: result.historyChecksum, no_top_k: true, production_effect: result.status === 'promoted' }),
    result.artifactChecksum,
  )]
  for (const artifact of result.artifacts) {
    const artifactId = `${runId}:${artifact.strategy_id}:${artifact.strategy_version}`
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO strategy_evidence_owner_calibration_artifacts_v1 (
        artifact_id, run_id, strategy_id, strategy_version, metric_outcome_as_of_date,
        multi_horizon_score, weight_multiplier, source_metric_checksum, payload_checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      artifactId,
      runId,
      artifact.strategy_id,
      artifact.strategy_version,
      artifact.metric_outcome_as_of_date,
      artifact.multi_horizon_score,
      artifact.weight_multiplier,
      artifact.source_metric_checksum,
      artifact.payload_checksum,
    ))
  }
  if (result.status === 'promoted') {
    statements.push(db.prepare(`
      INSERT INTO strategy_evidence_owner_calibration_head_v1 (singleton_id, run_id, artifact_checksum)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        run_id=excluded.run_id, artifact_checksum=excluded.artifact_checksum, promoted_at=CURRENT_TIMESTAMP
    `).bind(runId, result.artifactChecksum))
  }
  if (statements.length > 100) throw new Error('strategy_evidence_owner_calibration_atomic_batch_too_large')
  await db.batch(statements)
  const readback = await db.prepare(`
    SELECT r.status, r.artifact_checksum, COUNT(a.artifact_id) artifact_count
      FROM strategy_evidence_owner_calibration_runs_v1 r
      LEFT JOIN strategy_evidence_owner_calibration_artifacts_v1 a ON a.run_id=r.run_id
     WHERE r.run_id=? GROUP BY r.run_id
  `).bind(runId).first<{ status: string; artifact_checksum: string; artifact_count: number | string }>()
  if (readback?.status !== result.status || readback.artifact_checksum !== result.artifactChecksum
    || Number(readback.artifact_count) !== result.artifacts.length) {
    throw new Error('strategy_evidence_owner_calibration_readback_mismatch')
  }
  return { runId, result }
}

export async function loadPromotedStrategyEvidenceOwnerCalibrationBefore(
  db: D1Database,
  knowledgeCutoffDate: string,
): Promise<PromotedStrategyEvidenceOwnerCalibration | null> {
  const run = await db.prepare(`
    SELECT r.run_id, r.knowledge_cutoff_date, r.source_snapshot_checksum, r.artifact_checksum
      FROM strategy_evidence_owner_calibration_head_v1 h
      JOIN strategy_evidence_owner_calibration_runs_v1 r ON r.run_id=h.run_id
     WHERE h.singleton_id=1 AND r.status='promoted' AND r.knowledge_cutoff_date<=?
       AND h.artifact_checksum=r.artifact_checksum
  `).bind(knowledgeCutoffDate).first<{
    run_id: string
    knowledge_cutoff_date: string
    source_snapshot_checksum: string
    artifact_checksum: string
  }>()
  if (!run) return null
  const result = await db.prepare(`
    SELECT strategy_id, strategy_version, metric_outcome_as_of_date, multi_horizon_score,
           weight_multiplier, source_metric_checksum, payload_checksum
      FROM strategy_evidence_owner_calibration_artifacts_v1
     WHERE run_id=? ORDER BY strategy_id, strategy_version
  `).bind(run.run_id).all<StrategyEvidenceOwnerCalibrationArtifactRow>()
  const artifacts = result.results ?? []
  for (const artifact of artifacts) {
    const expected = await sha256(JSON.stringify({
      strategy_id: artifact.strategy_id,
      strategy_version: artifact.strategy_version,
      metric_outcome_as_of_date: artifact.metric_outcome_as_of_date,
      multi_horizon_score: finite(artifact.multi_horizon_score),
      weight_multiplier: Number(artifact.weight_multiplier),
      source_metric_checksum: artifact.source_metric_checksum,
    }))
    if (expected !== artifact.payload_checksum || artifact.source_metric_checksum !== run.source_snapshot_checksum) {
      return null
    }
  }
  return {
    runId: run.run_id,
    artifactChecksum: run.artifact_checksum,
    sourceMetricChecksum: run.source_snapshot_checksum,
    knowledgeCutoffDate: run.knowledge_cutoff_date,
    artifacts,
  }
}
