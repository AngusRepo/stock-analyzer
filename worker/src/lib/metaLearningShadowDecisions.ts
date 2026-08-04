import {
  metaPolicyRewardForSourceRow,
  modelFamilyArm,
  type LinUcbRewardSourceRow,
} from './metaLearningRewardLedger'
import type { MetaLearningTrackId } from './metaLearningResearchTrack'

export type ShadowPolicyId = Extract<MetaLearningTrackId, 'NeuralUCB' | 'NeuralTS' | 'NeuCB'>

export interface MetaShadowDecisionInputRow {
  business_date?: string
  symbol?: string
  arm_id?: string
  baseline_action?: string
  shadow_action?: string
  counterfactual_reward?: number | string | null
  context?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

export interface MetaShadowDecisionRow {
  decision_id: string
  policy_id: ShadowPolicyId
  business_date: string
  symbol: string
  arm_id: string
  baseline_action: string
  shadow_action: string
  counterfactual_reward: number | null
  context_json: string
  evidence_json: string
  created_at: string
}

export interface MetaShadowDecisionNormalizeResult {
  ok: boolean
  errors: string[]
  rows: MetaShadowDecisionRow[]
}

export interface MetaShadowDecisionSummary {
  samples: number
  counterfactual_reward_mean: number | null
  changed_action_count: number
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function cleanToken(value: unknown): string {
  return String(value ?? '').trim()
}

function safeJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}'
  return JSON.stringify(value)
}

function isShadowPolicy(value: unknown): value is ShadowPolicyId {
  return value === 'NeuralUCB' || value === 'NeuralTS' || value === 'NeuCB'
}

export function normalizeMetaShadowDecisionInput(
  input: unknown,
  options: { nowIso?: string; idPrefix?: string } = {},
): MetaShadowDecisionNormalizeResult {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const idPrefix = options.idPrefix ?? 'shadow'
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const policyId = cleanToken(body.policy_id)
  const errors: string[] = []
  if (!isShadowPolicy(policyId)) errors.push(`unsupported_shadow_policy:${policyId || 'missing'}`)

  const decisions = Array.isArray(body.decisions) ? body.decisions as MetaShadowDecisionInputRow[] : []
  if (decisions.length === 0) errors.push('decisions_required')
  if (decisions.length > 1000) errors.push('decisions_too_large:max_1000')

  const rows: MetaShadowDecisionRow[] = []
  if (isShadowPolicy(policyId)) {
    decisions.slice(0, 1000).forEach((decision, index) => {
      const businessDate = cleanToken(decision.business_date)
      const symbol = cleanToken(decision.symbol)
      const armId = cleanToken(decision.arm_id)
      const baselineAction = cleanToken(decision.baseline_action)
      const shadowAction = cleanToken(decision.shadow_action)
      if (!businessDate) errors.push(`decision_${index}:business_date_required`)
      if (!symbol) errors.push(`decision_${index}:symbol_required`)
      if (!armId) errors.push(`decision_${index}:arm_id_required`)
      if (!baselineAction) errors.push(`decision_${index}:baseline_action_required`)
      if (!shadowAction) errors.push(`decision_${index}:shadow_action_required`)
      if (!businessDate || !symbol || !armId || !baselineAction || !shadowAction) return
      rows.push({
        decision_id: `${idPrefix}-${policyId}-${businessDate}-${symbol}-${armId}-${index}`,
        policy_id: policyId,
        business_date: businessDate,
        symbol,
        arm_id: armId,
        baseline_action: baselineAction,
        shadow_action: shadowAction,
        counterfactual_reward: toFiniteNumber(decision.counterfactual_reward),
        context_json: safeJson(decision.context),
        evidence_json: safeJson(decision.evidence),
        created_at: nowIso,
      })
    })
  }

  return { ok: errors.length === 0, errors, rows }
}

export function summarizeMetaShadowDecisionRows(rows: MetaShadowDecisionRow[]): MetaShadowDecisionSummary {
  const rewards = rows
    .map((row) => row.counterfactual_reward)
    .filter((value): value is number => value != null && Number.isFinite(value))
  const rewardMean = rewards.length > 0
    ? Math.round((rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length) * 1_000_000) / 1_000_000
    : null
  return {
    samples: rows.length,
    counterfactual_reward_mean: rewardMean,
    changed_action_count: rows.filter((row) => row.baseline_action !== row.shadow_action).length,
  }
}

export async function persistMetaShadowDecisionRows(db: D1Database, rows: MetaShadowDecisionRow[]): Promise<number> {
  let persisted = 0
  for (const row of rows) {
    await db.prepare(`
      INSERT OR REPLACE INTO meta_shadow_decisions (
        decision_id, policy_id, business_date, symbol, arm_id,
        baseline_action, shadow_action, counterfactual_reward,
        context_json, evidence_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.decision_id,
      row.policy_id,
      row.business_date,
      row.symbol,
      row.arm_id,
      row.baseline_action,
      row.shadow_action,
      row.counterfactual_reward,
      row.context_json,
      row.evidence_json,
      row.created_at,
    ).run()
    persisted += 1
  }
  return persisted
}

export interface MetaShadowRewardHydrationReport {
  source_rows: number
  eligible_decisions: number
  hydrated_decisions: number
  unmatched_decisions: number
  end_date: string
}

type HydrationSourceRow = LinUcbRewardSourceRow & {
  decision_id: string
  business_date: string
  symbol: string
  arm_id: string
  evidence_json?: string | null
}

function parseEvidence(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function decisionArmMatchesModel(armId: string, modelName: unknown): boolean {
  const family = modelFamilyArm(modelName)
  if (armId === 'feature_family') {
    return ['tree_family', 'tabular_neural_family', 'graph_family'].includes(family)
  }
  return family === armId
}

export async function hydrateMatureMetaShadowDecisionRewards(
  db: D1Database,
  options: { endDate: string; limit?: number; nowIso?: string },
): Promise<MetaShadowRewardHydrationReport> {
  const limit = Math.max(1, Math.min(options.limit ?? 20000, 50000))
  const nowIso = options.nowIso ?? new Date().toISOString()
  const { results } = await db.prepare(`
    SELECT d.decision_id,
           d.business_date,
           d.symbol,
           d.arm_id,
           d.evidence_json,
           p.model_name,
           p.direction_correct,
           p.trade_pnl_pct,
           p.actual_return_pct
      FROM meta_shadow_decisions d
      JOIN predictions p
        ON CAST(p.stock_id AS TEXT) = d.symbol
       AND date(p.prediction_date) = date(d.business_date)
     WHERE d.counterfactual_reward IS NULL
       AND date(d.business_date) <= date(?)
       AND p.verified_at IS NOT NULL
       AND (p.direction_correct IS NOT NULL OR p.trade_pnl_pct IS NOT NULL OR p.actual_return_pct IS NOT NULL)
     ORDER BY date(d.business_date) ASC, d.decision_id ASC, p.model_name ASC
     LIMIT ?
  `).bind(options.endDate, limit).all<HydrationSourceRow>()

  const buckets = new Map<string, {
    row: HydrationSourceRow
    rewards: number[]
    models: Set<string>
  }>()
  for (const row of results ?? []) {
    const bucket = buckets.get(row.decision_id) ?? { row, rewards: [], models: new Set<string>() }
    if (row.arm_id === 'do_nothing') {
      bucket.rewards.push(0)
    } else if (decisionArmMatchesModel(row.arm_id, row.model_name)) {
      const reward = metaPolicyRewardForSourceRow(row)
      if (reward != null) bucket.rewards.push(reward)
      if (row.model_name) bucket.models.add(String(row.model_name))
    }
    buckets.set(row.decision_id, bucket)
  }

  let hydrated = 0
  for (const { row, rewards, models } of buckets.values()) {
    if (rewards.length === 0) continue
    const reward = Math.round((rewards.reduce((sum, value) => sum + value, 0) / rewards.length) * 1_000_000) / 1_000_000
    const evidence = {
      ...parseEvidence(row.evidence_json),
      outcome_hydration: {
        status: 'verified_mature_outcome',
        hydrated_at: nowIso,
        reward_policy: 'direction_hit_edge_0.30_plus_clipped_pnl_0.15_normalized',
        model_family_arm: row.arm_id,
        source_models: [...models].sort(),
        source_samples: rewards.length,
      },
    }
    const result = await db.prepare(`
      UPDATE meta_shadow_decisions
         SET counterfactual_reward = ?, evidence_json = ?
       WHERE decision_id = ?
         AND counterfactual_reward IS NULL
    `).bind(reward, JSON.stringify(evidence), row.decision_id).run()
    hydrated += Number(result.meta?.changes ?? 0)
  }

  return {
    source_rows: (results ?? []).length,
    eligible_decisions: buckets.size,
    hydrated_decisions: hydrated,
    unmatched_decisions: Math.max(0, buckets.size - hydrated),
    end_date: options.endDate,
  }
}
