import { listStrategyEvidenceProfiles } from './strategyEvidenceProfile'
import type { StrategySpec } from './strategySpec'

export const STRATEGY_EVIDENCE_OWNER_FUSION_VERSION = 'strategy-evidence-owner-fusion-v1' as const

type MetricRow = {
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
  materialized_metrics: number
  ready_metrics: number
  required_metrics: number
  integration_status: 'ready' | 'materialized_learning' | 'missing'
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
  weight_effect: 'mature_ready_only'
  profiles: StrategyEvidenceOwnerProfile[]
  checksum: string
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function sha256(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function buildStrategyEvidenceOwnerSnapshot(input: {
  strategies: readonly StrategySpec[]
  rows: readonly MetricRow[]
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
    const materializedMetrics = rows.filter((row) => finite(row?.metric_value) != null).length
    const readyMetrics = rows.filter((row) => row?.metric_status === 'ready').length
    return {
      strategy_id: profile.strategy_id,
      strategy_status: profile.strategy_status,
      materialized_metrics: materializedMetrics,
      ready_metrics: readyMetrics,
      required_metrics: profile.required_metrics.length,
      integration_status: readyMetrics === profile.required_metrics.length
        ? 'ready'
        : materializedMetrics === profile.required_metrics.length
          ? 'materialized_learning'
          : 'missing',
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
    weight_effect: 'mature_ready_only',
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
  `).bind(knowledgeCutoffDate).all<MetricRow>().catch(() => ({ results: [] as MetricRow[] }))
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
