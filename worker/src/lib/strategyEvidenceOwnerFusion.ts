import { listStrategyEvidenceProfiles } from './strategyEvidenceProfile'
import type { StrategySpec } from './strategySpec'

export const STRATEGY_EVIDENCE_OWNER_FUSION_VERSION = 'strategy-evidence-owner-fusion-v2' as const

export type StrategyEvidenceOwnerMetricRow = {
  strategy_id: string
  strategy_version: string
  primary_horizon_days: number | string
  metric_name: string
  metric_value: number | string | null
  metric_status: string
  sample_count: number | string
  mature_dates: number | string
  outcome_as_of_date: string
  definition_version: string
}

export type StrategyEvidenceOwnerProfile = {
  strategy_id: string
  strategy_status: string
  primary_horizon_days: number
  materialized_metrics: number
  ready_metrics: number
  required_metrics: number
  integration_status: 'ready' | 'materialized_learning' | 'missing'
  multi_horizon_score: number | null
  weight_multiplier: number
  weight_effect: 'bounded_bidirectional' | 'neutral_not_fully_ready'
  metric_evidence: Array<{
    metric_name: string
    metric_value: number | null
    metric_status: string
    normalized_score: number | null
  }>
}

export type StrategyEvidenceOwnerSnapshot = {
  version: typeof STRATEGY_EVIDENCE_OWNER_FUSION_VERSION
  knowledge_cutoff_date: string
  outcome_as_of_date: string | null
  active_profile_count: number
  active_materialized_profile_count: number
  active_ready_profile_count: number
  learning_profile_count: number
  integration_ready: boolean
  weight_effect: 'mature_ready_only_bounded_bidirectional'
  profiles: StrategyEvidenceOwnerProfile[]
  checksum: string
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

/**
 * Converts heterogeneous strategy metrics to a common [-1, 1] edge scale.
 * Zero is neutral. The final owner multiplier is capped at +/-25%, so one
 * metric cannot dominate the adaptive policy or bypass its hard-risk gate.
 */
export function normalizeStrategyEvidenceMetric(
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

async function sha256(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function buildStrategyEvidenceOwnerSnapshot(input: {
  strategies: readonly StrategySpec[]
  rows: readonly StrategyEvidenceOwnerMetricRow[]
  knowledgeCutoffDate: string
}): Promise<StrategyEvidenceOwnerSnapshot> {
  const profiles = listStrategyEvidenceProfiles([...input.strategies])
    .filter((profile) => profile.strategy_status === 'active' || profile.strategy_status === 'shadow')
  const validRows = input.rows.filter((row) => (
    /^\d{4}-\d{2}-\d{2}$/.test(row.outcome_as_of_date)
    && row.outcome_as_of_date < input.knowledgeCutoffDate
  ))
  const outcomeAsOfDate = validRows.map((row) => row.outcome_as_of_date).sort().at(-1) ?? null
  const latestRows = outcomeAsOfDate == null
    ? []
    : validRows.filter((row) => row.outcome_as_of_date === outcomeAsOfDate)
  const byKey = new Map(latestRows.map((row) => [
    `${row.strategy_id}|${row.strategy_version}|${Number(row.primary_horizon_days)}|${row.metric_name}`,
    row,
  ]))

  const ownerProfiles = profiles.map((profile): StrategyEvidenceOwnerProfile => {
    const rows = profile.required_metrics.map((metric) => byKey.get(
      `${profile.strategy_id}|${profile.strategy_version}|${profile.primary_horizon_days}|${metric}`,
    ))
    const metricEvidence = profile.required_metrics.map((metricName, index) => {
      const row = rows[index]
      const metricValue = finite(row?.metric_value)
      return {
        metric_name: metricName,
        metric_value: metricValue,
        metric_status: row?.metric_status ?? 'not_materialized',
        normalized_score: row?.metric_status === 'ready' && metricValue != null
          ? round6(normalizeStrategyEvidenceMetric(metricName, metricValue, profile.primary_horizon_days))
          : null,
      }
    })
    const materializedMetrics = rows.filter((row) => row != null).length
    const readyMetrics = rows.filter((row) => row?.metric_status === 'ready').length
    const fullyReady = readyMetrics === profile.required_metrics.length
    const normalizedScores = metricEvidence
      .map((row) => row.normalized_score)
      .filter((value): value is number => value != null)
    const multiHorizonScore = fullyReady && normalizedScores.length
      ? round6(normalizedScores.reduce((sum, value) => sum + value, 0) / normalizedScores.length)
      : null
    return {
      strategy_id: profile.strategy_id,
      strategy_status: profile.strategy_status,
      primary_horizon_days: profile.primary_horizon_days,
      materialized_metrics: materializedMetrics,
      ready_metrics: readyMetrics,
      required_metrics: profile.required_metrics.length,
      integration_status: fullyReady
        ? 'ready'
        : materializedMetrics === profile.required_metrics.length
          ? 'materialized_learning'
          : 'missing',
      multi_horizon_score: multiHorizonScore,
      weight_multiplier: multiHorizonScore == null
        ? 1
        : round6(clamp(1 + (0.25 * multiHorizonScore), 0.75, 1.25)),
      weight_effect: multiHorizonScore == null
        ? 'neutral_not_fully_ready'
        : 'bounded_bidirectional',
      metric_evidence: metricEvidence,
    }
  }).sort((left, right) => left.strategy_id.localeCompare(right.strategy_id))
  const active = ownerProfiles.filter((profile) => profile.strategy_status === 'active')
  const activeMaterialized = active.filter((profile) => (
    profile.materialized_metrics === profile.required_metrics
  )).length
  const activeReady = active.filter((profile) => (
    profile.ready_metrics === profile.required_metrics
  )).length
  const canonical = JSON.stringify({
    version: STRATEGY_EVIDENCE_OWNER_FUSION_VERSION,
    knowledge_cutoff_date: input.knowledgeCutoffDate,
    outcome_as_of_date: outcomeAsOfDate,
    profiles: ownerProfiles,
  })
  return {
    version: STRATEGY_EVIDENCE_OWNER_FUSION_VERSION,
    knowledge_cutoff_date: input.knowledgeCutoffDate,
    outcome_as_of_date: outcomeAsOfDate,
    active_profile_count: active.length,
    active_materialized_profile_count: activeMaterialized,
    active_ready_profile_count: activeReady,
    learning_profile_count: ownerProfiles.length,
    integration_ready: active.length > 0 && activeMaterialized === active.length,
    weight_effect: 'mature_ready_only_bounded_bidirectional',
    profiles: ownerProfiles,
    checksum: await sha256(canonical),
  }
}

export async function loadStrategyEvidenceOwnerSnapshotBefore(
  db: D1Database,
  strategies: readonly StrategySpec[],
  knowledgeCutoffDate: string,
): Promise<StrategyEvidenceOwnerSnapshot> {
  const rows = await db.prepare(`
    SELECT strategy_id, strategy_version, primary_horizon_days, metric_name,
           metric_value, metric_status, sample_count, mature_dates,
           outcome_as_of_date, definition_version
      FROM strategy_evidence_metrics_v1
     WHERE outcome_as_of_date < ?
     ORDER BY outcome_as_of_date DESC, strategy_id, metric_name
  `).bind(knowledgeCutoffDate).all<StrategyEvidenceOwnerMetricRow>()
    .catch(() => ({ results: [] as StrategyEvidenceOwnerMetricRow[] }))
  return buildStrategyEvidenceOwnerSnapshot({
    strategies,
    rows: rows.results ?? [],
    knowledgeCutoffDate,
  })
}

export function strategyEvidenceOwnerLineageMatches(
  snapshot: StrategyEvidenceOwnerSnapshot,
  baseWeightRunId: string | null | undefined,
): boolean {
  return snapshot.integration_ready
    && Boolean(baseWeightRunId)
    && String(baseWeightRunId).includes(`${snapshot.version}:${snapshot.checksum}`)
}
