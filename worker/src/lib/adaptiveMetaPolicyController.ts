import type { Bindings } from '../types'
import { getAdaptiveParams, setAdaptiveParams, type AdaptiveParams } from './adaptiveConfig'
import { databaseForDataDomain } from './dataDomainRegistry'

const STATE_KEY = 'meta:adaptive_policy_controller:state'
const CONTROLLER_VERSION = 'adaptive-meta-policy-controller-v1'
const CANARY_CAP = 0.05
const MAX_CAP = 0.15
const CANARY_STREAK = 2
const ACTIVE_STREAK = 4
const MIN_WINDOWS = 8
const MAX_EVIDENCE_AGE_DAYS = 14
const ACTIVE_MODELS = new Set([
  'LightGBM', 'XGBoost', 'ExtraTrees', 'TabM',
  'GNN', 'DLinear', 'PatchTST', 'iTransformer',
])

export type AdaptiveMetaPolicyPhase = 'inactive' | 'observing' | 'canary' | 'active' | 'rolled_back'

export interface AdaptiveMetaPolicyControllerState {
  schema_version: typeof CONTROLLER_VERSION
  phase: AdaptiveMetaPolicyPhase
  observed_method: string | null
  consecutive_passes: number
  serving_policy: Record<string, unknown> | null
  last_candidate_id: string | null
  last_run_date: string
  last_decision: string
  updated_at: string
}

export interface AdaptiveMetaPolicyTransition {
  decision: 'reject' | 'observe' | 'promote_canary' | 'promote_active' | 'retain_canary' | 'retain_active' | 'rollback'
  reason: string
  mutation: 'none' | 'apply' | 'remove'
  next_state: AdaptiveMetaPolicyControllerState
  policy: Record<string, unknown> | null
  failed_checks: string[]
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function dateAgeDays(runDate: string, evidenceDate: string): number | null {
  const run = Date.parse(`${runDate}T00:00:00Z`)
  const evidence = Date.parse(`${evidenceDate}T00:00:00Z`)
  if (!Number.isFinite(run) || !Number.isFinite(evidence)) return null
  return Math.floor((run - evidence) / 86_400_000)
}

function emptyState(runDate: string): AdaptiveMetaPolicyControllerState {
  return {
    schema_version: CONTROLLER_VERSION,
    phase: 'inactive',
    observed_method: null,
    consecutive_passes: 0,
    serving_policy: null,
    last_candidate_id: null,
    last_run_date: runDate,
    last_decision: 'initialized',
    updated_at: new Date().toISOString(),
  }
}

function normalizeState(value: unknown, runDate: string): AdaptiveMetaPolicyControllerState {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
  const phase = ['inactive', 'observing', 'canary', 'active', 'rolled_back'].includes(String(raw.phase))
    ? raw.phase as AdaptiveMetaPolicyPhase
    : 'inactive'
  return {
    ...emptyState(runDate),
    phase,
    observed_method: typeof raw.observed_method === 'string' ? raw.observed_method : null,
    consecutive_passes: Math.max(0, Math.floor(Number(raw.consecutive_passes) || 0)),
    serving_policy: raw.serving_policy && typeof raw.serving_policy === 'object' && !Array.isArray(raw.serving_policy)
      ? raw.serving_policy as Record<string, unknown>
      : null,
    last_candidate_id: typeof raw.last_candidate_id === 'string' ? raw.last_candidate_id : null,
    last_run_date: typeof raw.last_run_date === 'string' ? raw.last_run_date : runDate,
    last_decision: typeof raw.last_decision === 'string' ? raw.last_decision : 'unknown',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
  }
}

function candidateChecks(evidence: Record<string, any>, runDate: string): {
  candidate: Record<string, any> | null
  method: string | null
  candidateId: string | null
  failed: string[]
} {
  const failed: string[] = []
  const candidate = evidence.allocator_policy_candidate && typeof evidence.allocator_policy_candidate === 'object'
    ? evidence.allocator_policy_candidate as Record<string, any>
    : null
  const method = String(candidate?.method ?? evidence.recommended_method ?? '').trim() || null
  const candidateId = String(candidate?.policy_id ?? '').trim() || null
  const gates = Array.isArray(evidence.gates) ? evidence.gates : []
  const gateFailures = gates.filter((gate: any) => !gate || gate.passed !== true)
  const averageReward = finite(candidate?.evidence?.average_reward)
  const windows = Math.floor(finite(candidate?.evidence?.sample_windows ?? evidence.sample_windows) ?? 0)
  const evidenceDate = String(candidate?.evidence?.date_end ?? evidence.date_end ?? '').slice(0, 10)
  const ageDays = dateAgeDays(runDate, evidenceDate)
  const cap = finite(candidate?.model_multiplier_cap ?? candidate?.production_cap)
  const multipliers = candidate?.model_weight_multipliers

  if (evidence.status !== 'pass') failed.push('replay_status_not_pass')
  if (gateFailures.length > 0) failed.push('replay_gate_failed')
  if (candidate?.status !== 'candidate_requires_approval') failed.push('candidate_status_not_eligible')
  if (candidate?.allowed_target !== 'ml:adaptive_params.model_allocator') failed.push('target_not_model_allocator')
  if (!method || method !== String(evidence.recommended_method ?? '')) failed.push('recommended_method_mismatch')
  if (!candidateId) failed.push('candidate_id_missing')
  if (averageReward == null || averageReward <= 0) failed.push('average_reward_not_positive')
  if (windows < MIN_WINDOWS) failed.push('insufficient_windows')
  if (ageDays == null || ageDays < 0 || ageDays > MAX_EVIDENCE_AGE_DAYS) failed.push('evidence_not_fresh')
  if (cap == null || cap <= 0 || cap > MAX_CAP) failed.push('candidate_cap_invalid')
  if (!multipliers || typeof multipliers !== 'object' || Array.isArray(multipliers)) {
    failed.push('model_multipliers_missing')
  } else {
    const entries = Object.entries(multipliers)
    if (entries.length < 4) failed.push('model_multiplier_coverage_insufficient')
    for (const [model, value] of entries) {
      const multiplier = finite(value)
      if (!ACTIVE_MODELS.has(model) || multiplier == null || multiplier < 1 - MAX_CAP || multiplier > 1 + MAX_CAP) {
        failed.push('model_multiplier_invalid')
        break
      }
    }
  }
  return { candidate, method, candidateId, failed: [...new Set(failed)] }
}

function servingPolicy(candidate: Record<string, any>, phase: 'canary' | 'active', runDate: string): Record<string, unknown> {
  const sourceCap = Math.min(MAX_CAP, Math.max(0.000001, Number(candidate.model_multiplier_cap ?? candidate.production_cap ?? MAX_CAP)))
  const targetCap = phase === 'canary' ? Math.min(CANARY_CAP, sourceCap) : sourceCap
  const scale = targetCap / sourceCap
  const multipliers: Record<string, number> = {}
  for (const [model, raw] of Object.entries(candidate.model_weight_multipliers ?? {})) {
    const value = Number(raw)
    multipliers[model] = Number((1 + (value - 1) * scale).toFixed(6))
  }
  return {
    schema_version: 'allocator-policy-v1',
    policy_id: `${candidate.policy_id}:${phase}:${runDate}`,
    candidate_policy_id: candidate.policy_id,
    source: CONTROLLER_VERSION,
    method: candidate.method,
    status: 'capped_production_approved',
    approval_status: 'capped_production_approved',
    approved: true,
    approved_level: 'L3',
    auto_approved_by: CONTROLLER_VERSION,
    production_effect: 'capped_production_effect',
    production_cap: targetCap,
    model_multiplier_cap: targetCap,
    model_weight_multipliers: multipliers,
    risk_off_cash_bias: finite(candidate.risk_off_cash_bias) ?? 0,
    mutation_allowed: true,
    real_trading_allowed: false,
    phase,
    effective_from: runDate,
    rollback_policy: 'first_failed_or_stale_weekly_replay_returns_to_baseline',
    evidence: candidate.evidence ?? {},
  }
}

export function planAdaptiveMetaPolicyTransition(
  evidence: Record<string, any>,
  priorValue: unknown,
  runDate: string,
): AdaptiveMetaPolicyTransition {
  const prior = normalizeState(priorValue, runDate)
  const check = candidateChecks(evidence, runDate)
  const now = new Date().toISOString()
  if (check.failed.length > 0 || !check.candidate || !check.method || !check.candidateId) {
    const ownsServingPolicy = prior.serving_policy?.source === CONTROLLER_VERSION
    const decision = ownsServingPolicy ? 'rollback' : 'reject'
    return {
      decision,
      reason: check.failed.join(',') || 'candidate_missing',
      mutation: ownsServingPolicy ? 'remove' : 'none',
      policy: null,
      failed_checks: check.failed,
      next_state: {
        ...emptyState(runDate),
        phase: ownsServingPolicy ? 'rolled_back' : 'inactive',
        last_candidate_id: check.candidateId,
        last_run_date: runDate,
        last_decision: decision,
        updated_at: now,
      },
    }
  }

  const streak = prior.observed_method === check.method ? prior.consecutive_passes + 1 : 1
  let decision: AdaptiveMetaPolicyTransition['decision'] = 'observe'
  let mutation: AdaptiveMetaPolicyTransition['mutation'] = 'none'
  let phase: AdaptiveMetaPolicyPhase = prior.serving_policy ? prior.phase : 'observing'
  let policy = prior.serving_policy
  if (streak >= ACTIVE_STREAK) {
    decision = prior.phase === 'active' && prior.observed_method === check.method ? 'retain_active' : 'promote_active'
    phase = 'active'
    policy = servingPolicy(check.candidate, 'active', runDate)
    mutation = 'apply'
  } else if (streak >= CANARY_STREAK) {
    decision = prior.phase === 'canary' && prior.observed_method === check.method ? 'retain_canary' : 'promote_canary'
    phase = 'canary'
    policy = servingPolicy(check.candidate, 'canary', runDate)
    mutation = 'apply'
  }
  return {
    decision,
    reason: `eligible_method=${check.method} consecutive_passes=${streak}`,
    mutation,
    policy,
    failed_checks: [],
    next_state: {
      schema_version: CONTROLLER_VERSION,
      phase,
      observed_method: check.method,
      consecutive_passes: streak,
      serving_policy: policy,
      last_candidate_id: check.candidateId,
      last_run_date: runDate,
      last_decision: decision,
      updated_at: now,
    },
  }
}

async function writeDecisionStart(
  env: Pick<Bindings, 'DB'>,
  decisionId: string,
  runDate: string,
  transition: AdaptiveMetaPolicyTransition,
  evidence: Record<string, any>,
  previousPolicyId: string | null,
): Promise<void> {
  await databaseForDataDomain(env, 'learning').prepare(`
    INSERT INTO adaptive_meta_policy_decisions (
      decision_id, run_date, candidate_policy_id, method, decision, reason,
      phase, consecutive_passes, previous_policy_id, serving_policy_id,
      apply_status, failed_checks_json, evidence_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_apply', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    decisionId,
    runDate,
    transition.next_state.last_candidate_id,
    transition.next_state.observed_method,
    transition.decision,
    transition.reason,
    transition.next_state.phase,
    transition.next_state.consecutive_passes,
    previousPolicyId,
    String(transition.policy?.policy_id ?? '') || null,
    JSON.stringify(transition.failed_checks),
    JSON.stringify(evidence),
  ).run()
}

async function finishDecision(env: Pick<Bindings, 'DB'>, decisionId: string, status: 'applied' | 'failed', error?: string): Promise<void> {
  await databaseForDataDomain(env, 'learning').prepare(`
    UPDATE adaptive_meta_policy_decisions
       SET apply_status=?, apply_error=?, updated_at=CURRENT_TIMESTAMP
     WHERE decision_id=?
  `).bind(status, error ?? null, decisionId).run()
}

export async function reconcileAdaptiveMetaPolicy(
  env: Pick<Bindings, 'DB' | 'KV'>,
  evidence: Record<string, any>,
  runDate: string,
): Promise<AdaptiveMetaPolicyTransition> {
  const prior = await env.KV.get(STATE_KEY, 'json')
  const transition = planAdaptiveMetaPolicyTransition(evidence, prior, runDate)
  const current = await getAdaptiveParams(env.KV)
  const previousPolicy = current.model_allocator && typeof current.model_allocator === 'object'
    ? current.model_allocator
    : null
  const previousPolicyId = String(previousPolicy?.policy_id ?? '') || null
  const decisionId = `adaptive-meta:${runDate}:${Date.now()}:${crypto.randomUUID()}`
  await writeDecisionStart(env, decisionId, runDate, transition, evidence, previousPolicyId)

  let adaptiveMutated = false
  try {
    if (transition.mutation !== 'none') {
      const next: AdaptiveParams = { ...current, version: Number(current.version ?? 0) + 1 }
      if (transition.mutation === 'apply' && transition.policy) next.model_allocator = transition.policy
      if (transition.mutation === 'remove' && previousPolicy?.source === CONTROLLER_VERSION) delete next.model_allocator
      await setAdaptiveParams(env.KV, next, { source: CONTROLLER_VERSION, fallback: false })
      adaptiveMutated = true
    }
    await env.KV.put(STATE_KEY, JSON.stringify(transition.next_state), { expirationTtl: 400 * 86400 })
    await finishDecision(env, decisionId, 'applied')
    return transition
  } catch (error: any) {
    if (adaptiveMutated) {
      const rollback: AdaptiveParams = { ...current, version: Number(current.version ?? 0) + 2 }
      await setAdaptiveParams(env.KV, rollback, { source: `${CONTROLLER_VERSION}:rollback`, fallback: false }).catch(() => {})
    }
    await finishDecision(env, decisionId, 'failed', error?.message ?? String(error)).catch(() => {})
    throw error
  }
}
