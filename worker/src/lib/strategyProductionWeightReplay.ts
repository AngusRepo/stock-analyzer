/** Frozen inputs of the ORIGINAL daily contribution owner, not another model. */
import { buildStrategyProductionPolicyState, type StrategyProductionPolicyInput } from './strategyProductionPolicyService'
import { sha256StrategyProductionPolicyPayload, resolveRuntimeStrategyWeights, type LoadedStrategyProductionPolicy } from './strategyProductionPolicyStore'
import type { StrategySpec } from './strategySpec'
import { buildStrategyReadinessWeights, strategyWeightEvidenceReady } from './strategyWeightReadiness'
import { sealStrategyEvidenceOwnerSnapshot } from './strategyEvidenceOwnerFusion'
import type { StrategyProductionFirewallState } from './strategyProductionContributionFirewall'
import type { AtomicShadowReplacement } from './atomicStrategyShadow'

export const STRATEGY_PRODUCTION_WEIGHT_KERNEL = 'strategy-original-daily-weight-owner-v1' as const
export interface StrategyProductionWeightSource {
  schema_version: 'strategy-production-weight-source-v1' | 'strategy-production-weight-source-v2'
  kernel_version: typeof STRATEGY_PRODUCTION_WEIGHT_KERNEL
  inputs: StrategyProductionPolicyInput
  baseline_policy_checksum: string
  source_checksum: string
}

function canonical(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('strategy_weight_source_nonfinite')
    return item
  })
  const order = (item: any): any => Array.isArray(item) ? item.map(order)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item
  return JSON.stringify(order(JSON.parse(json)))
}
const checksum = (value: unknown) => sha256StrategyProductionPolicyPayload(canonical(value))

/** Registry publication is immediate; serving remains PIT. Use roles from the
 * SAME already-available policy as its weights, never today's roles with an old
 * weight map. Definitions/membership may not silently change under this adapter.
 */
export async function resolveStrategyServingSpecs(current: readonly StrategySpec[],
  policy: LoadedStrategyProductionPolicy | null, signalDate: string): Promise<StrategySpec[]> {
  const source = policy && 'evidence_owner' in policy.state.evidence
    ? policy.state.evidence.evidence_owner?.weight_source : undefined
  if (!source) return structuredClone([...current]) // Pre-capsule legacy policy keeps its original behavior.
  const created = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(policy!.created_at)
    ? policy!.created_at.replace(' ', 'T') + 'Z' : policy!.created_at
  const deadline = Date.parse(signalDate + 'T00:00:00+08:00')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signalDate) || !Number.isFinite(deadline)
    || !Number.isFinite(Date.parse(created)) || Date.parse(created) >= deadline
    || policy!.state.knowledge_cutoff_date >= signalDate)
    throw new Error('strategy_serving_policy_not_available')
  const replay = await replayStrategyWeightSource(source)
  const stored = JSON.parse(policy!.state.canonical_payload)
  if (stored.evidence_owner) delete stored.evidence_owner.weight_source
  if (canonical(stored) !== canonical(JSON.parse(replay.state.canonical_payload)))
    throw new Error('strategy_serving_policy_source_mismatch')
  const definitions = (specs: readonly StrategySpec[]) => specs.map(spec => {
    const { status, promotionStatus, ...definition } = spec
    return definition
  }).sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(current.map(spec => spec.id)).size !== current.length
    || canonical(definitions(current)) !== canonical(definitions(source.inputs.strategies)))
    throw new Error('strategy_serving_registry_definition_changed')
  const frozen = new Map(source.inputs.strategies.map(spec => [spec.id, spec]))
  const roleChanged = current.filter(spec => spec.status !== frozen.get(spec.id)!.status
    || spec.promotionStatus !== frozen.get(spec.id)!.promotionStatus)
  const replaceable = (spec: StrategySpec) => spec.ownerType === 'strategy'
    && (spec.status === 'active' && spec.promotionStatus === 'production'
      || spec.status === 'candidate' && spec.promotionStatus === 'candidate')
  if (roleChanged.some(spec => !replaceable(spec) || !replaceable(frozen.get(spec.id)!))
    || roleChanged.filter(spec => spec.status === 'active').length
      !== roleChanged.filter(spec => frozen.get(spec.id)!.status === 'active').length)
    throw new Error('strategy_serving_registry_role_change_not_replacement')
  return current.map(spec => structuredClone(frozen.get(spec.id)!))
}

function readinessWeights(input: StrategyProductionPolicyInput) {
  const byId = new Map(input.gates.map(gate => [`${gate.strategy_id}|${gate.strategy_version}`, gate]))
  const ids = new Set<string>()
  const observations = input.strategies.map(spec => {
    const gate = byId.get(`${spec.id}|${spec.version}`)
    if (ids.has(spec.id) || !gate || gate.strategy_status !== spec.status
      || !Number.isFinite(gate.evidence?.samples) || !Number.isFinite(gate.evidence?.mature_dates))
      throw new Error('strategy_weight_source_registry_or_evidence_mismatch')
    ids.add(spec.id)
    return { id: spec.id, version: spec.version, status: spec.status,
      samples: gate.evidence.samples, matureDates: gate.evidence.mature_dates }
  })
  return buildStrategyReadinessWeights(observations, input.gates)
}

export async function captureStrategyWeightSource(input: StrategyProductionPolicyInput,
  state: StrategyProductionFirewallState): Promise<StrategyProductionWeightSource> {
  // This is the weight owner's executable input, not another lifecycle owner.
  // Role substitution must not re-publish the previous role's activation-gate,
  // lifecycle advice or threshold deltas. Keep only original consumed fields.
  const captured = JSON.parse(canonical({
    knowledgeCutoffDate: input.knowledgeCutoffDate,
    strategies: input.strategies,
    gates: input.gates.map(gate => ({
      strategy_id: gate.strategy_id, strategy_version: gate.strategy_version,
      strategy_status: gate.strategy_status, allocation_eligible: gate.allocation_eligible,
      decision: gate.decision,
      evidence: { samples: gate.evidence.samples, mature_dates: gate.evidence.mature_dates },
    })),
    adaptiveState: { strategy_weights: input.adaptiveState.strategy_weights,
      updated_at: input.adaptiveState.updated_at, evidence: { date: input.adaptiveState.evidence.date } },
    evidenceFusion: input.evidenceFusion,
  })) as StrategyProductionPolicyInput
  if (canonical(readinessWeights(captured)) !== canonical(captured.adaptiveState.strategy_weights))
    throw new Error('strategy_weight_source_adaptive_owner_mismatch')
  if (captured.knowledgeCutoffDate !== captured.evidenceFusion.knowledge_cutoff_date
    || captured.knowledgeCutoffDate !== captured.adaptiveState.evidence.date)
    throw new Error('strategy_weight_source_cutoff_mismatch')
  const rebuilt = buildStrategyProductionPolicyState(captured)
  if (canonical(JSON.parse(rebuilt.canonical_payload)) !== canonical(JSON.parse(state.canonical_payload)))
    throw new Error('strategy_weight_source_original_policy_mismatch')
  const body = { schema_version: 'strategy-production-weight-source-v2' as const,
    kernel_version: STRATEGY_PRODUCTION_WEIGHT_KERNEL, inputs: captured,
    baseline_policy_checksum: await checksum(JSON.parse(rebuilt.canonical_payload)) }
  return { ...body, source_checksum: await checksum(body) }
}

/** Baseline parity first; only then change the two role assignments. All market,
 * readiness and calibration inputs stay at the original pre-decision cutoff.
 */
export async function replayStrategyWeightSource(source: StrategyProductionWeightSource,
  replacement?: AtomicShadowReplacement) {
  const { source_checksum, ...body } = structuredClone(source)
  if (!['strategy-production-weight-source-v1', 'strategy-production-weight-source-v2'].includes(body.schema_version)
    || body.kernel_version !== STRATEGY_PRODUCTION_WEIGHT_KERNEL || source_checksum !== await checksum(body))
    throw new Error('strategy_weight_source_integrity_failed')
  const baseline = buildStrategyProductionPolicyState(body.inputs)
  const verified = await captureStrategyWeightSource(body.inputs, baseline)
  // Frozen v1 contains extra diagnostics. Validate its original bytes and the
  // identical weight baseline, but do not rewrite it or reset the experiment.
  // Newly captured v2 must also have the exact minimal source projection.
  if (verified.baseline_policy_checksum !== body.baseline_policy_checksum
    || body.schema_version === 'strategy-production-weight-source-v2' && verified.source_checksum !== source_checksum)
    throw new Error('strategy_weight_source_baseline_changed')
  const input = verified.inputs
  if (replacement) {
    const incumbent = input.strategies.find(spec => spec.id === replacement.incumbentId)
    const candidate = input.strategies.find(spec => spec.id === replacement.candidateId)
    if (!incumbent || !candidate || incumbent.id === candidate.id
      || incumbent.status !== 'active' || incumbent.promotionStatus !== 'production'
      || candidate.status !== 'candidate' || candidate.promotionStatus !== 'candidate'
      || incumbent.ownerType !== 'strategy' || candidate.ownerType !== 'strategy'
      || incumbent.version !== replacement.incumbentVersion || candidate.version !== replacement.candidateVersion)
      throw new Error('strategy_weight_source_replacement_changed')
    input.strategies = input.strategies.map(spec => spec.id === candidate.id
      ? { ...spec, status: 'active', promotionStatus: 'production' }
      : spec.id === incumbent.id ? { ...spec, status: 'candidate', promotionStatus: 'candidate' } : spec)
    input.gates = input.gates.map(gate => {
      if (![candidate.id, incumbent.id].includes(gate.strategy_id)) return gate
      const active = gate.strategy_id === candidate.id
      return { ...gate, strategy_status: active ? 'active' : 'candidate',
        allocation_eligible: active && strategyWeightEvidenceReady(gate.evidence.samples, gate.evidence.mature_dates),
        decision: active ? 'active_monitor' : 'not_ready' }
    })
    const profiles = input.evidenceFusion.profiles
    if (!profiles.some(profile => profile.strategy_id === candidate.id))
      throw new Error('strategy_weight_source_candidate_profile_missing')
    input.evidenceFusion = await sealStrategyEvidenceOwnerSnapshot({
      knowledgeCutoffDate: input.knowledgeCutoffDate, outcomeAsOfDate: input.evidenceFusion.outcome_as_of_date,
      calibrationRunId: input.evidenceFusion.calibration_run_id,
      calibrationArtifactChecksum: input.evidenceFusion.calibration_artifact_checksum,
      weightEffect: input.evidenceFusion.weight_effect,
      profiles: profiles.map(profile => profile.strategy_id === candidate.id
        ? { ...profile, strategy_status: 'active' }
        : profile.strategy_id === incumbent.id ? { ...profile, strategy_status: 'candidate' } : profile),
    })
    input.adaptiveState.strategy_weights = readinessWeights(input)
  }
  const state = replacement ? buildStrategyProductionPolicyState(input) : baseline
  return { state, inputs: input, weights: resolveRuntimeStrategyWeights(input.strategies.map(spec => spec.id), {
    state, checksum: await checksum(JSON.parse(state.canonical_payload)), created_at: input.adaptiveState.updated_at,
  }) }
}
