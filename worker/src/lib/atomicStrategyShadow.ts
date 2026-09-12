/** Atomic one-in/one-out through the ORIGINAL full-universe L1 -> L1.5 owner.
 * Compute-only: no database, registry mutation, order, promotion or NAV credit.
 * A different slate still needs its own frozen ML inference and paired execution.
 */
import { buildLayer1StrategyBreadthPlan, type StrategyCandidatePoolCandidate } from './strategyCandidatePool'
import { normalizeStrategySpecGovernance, validateStrategySpec, type StrategySpec } from './strategySpec'
import type { AtomicPostOverlayInputs } from './screenerOverlayCapture'
import { decodeScreenerCoreSeedContext, materializeScreenerCoreSeeds, type CoreSeedCandidate } from './screenerCoreSeedMaterializer'
import { replayFrozenPostRoute } from './screenerFrozenOverlayReplay'
import { replayFrozenCandidateCoreSeeds } from './screenerCandidateCoreReplay'
import { replayStrategyWeightSource, STRATEGY_PRODUCTION_WEIGHT_KERNEL,
  type StrategyProductionWeightSource } from './strategyProductionWeightReplay'

type BreadthOptions = Parameters<typeof buildLayer1StrategyBreadthPlan>[2]
export type AtomicShadowOptions = BreadthOptions & {
  strategyWeights: Record<string, number>
  productionStrategyWeights: Record<string, number>
}
export interface AtomicShadowReplacement {
  candidateId: string
  candidateVersion: string
  incumbentId: string
  incumbentVersion: string
}

function strictSpecs(specs: StrategySpec[]): StrategySpec[] {
  const ids = new Set<string>()
  return specs.map(input => {
    const spec = normalizeStrategySpecGovernance(structuredClone(input))
    if (!spec.id || !spec.version || ids.has(spec.id) || !validateStrategySpec(spec).ok) {
      throw new Error('atomic_shadow_spec_identity_invalid')
    }
    ids.add(spec.id)
    return spec
  })
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Structural population only. Never preselect using realized return/LCB. */
export function enumerateAtomicShadowReplacements(specs: StrategySpec[], options: AtomicShadowOptions): AtomicShadowReplacement[] {
  const normalized = strictSpecs(specs)
  for (const spec of normalized.filter(s => s.status !== 'retired')) {
    for (const weights of [options.strategyWeights, options.productionStrategyWeights]) {
      const value = weights?.[spec.id]
      if (!Object.hasOwn(weights ?? {}, spec.id) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`atomic_shadow_weight_missing_or_invalid:${spec.id}`)
      }
    }
  }
  const incumbents = normalized.filter(s => s.status === 'active' && s.ownerType === 'strategy'
    && s.promotionStatus === 'production' && positive(options.productionStrategyWeights[s.id])
    && positive(options.strategyWeights[s.id]))
  const candidates = normalized.filter(s => s.status === 'candidate' && s.ownerType === 'strategy'
    && s.promotionStatus === 'candidate' && positive(options.strategyWeights[s.id])
    && options.productionStrategyWeights[s.id] === 0)
  return candidates.flatMap(candidate => incumbents.map(incumbent => ({
    candidateId: candidate.id, candidateVersion: candidate.version,
    incumbentId: incumbent.id, incumbentVersion: incumbent.version,
  }))).sort((a, b) => `${a.candidateId}|${a.incumbentId}`.localeCompare(`${b.candidateId}|${b.incumbentId}`))
}

function sortedJson(value: unknown): string {
  // JSON is the frozen transport. Reject non-finite numbers rather than turn
  // them into null and silently claim the same experiment inputs.
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('atomic_shadow_nonfinite_input')
    return item
  })
  const order = (item: any): any => Array.isArray(item) ? item.map(order)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item
  return JSON.stringify(order(JSON.parse(serialized)))
}

async function checksum(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sortedJson(value)))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

function validateUniverse(symbols: string[], expected: string[]): void {
  // Empty is valid only when explicitly sealed as empty. Missing inputs are
  // not converted into a no-hit day. Reject aliases before the real router.
  if (symbols.some(symbol => typeof symbol !== 'string' || !symbol.trim() || symbol !== symbol.trim())
    || expected.some(symbol => typeof symbol !== 'string' || !symbol.trim() || symbol !== symbol.trim())
    || new Set(symbols.map(s => s.toUpperCase())).size !== symbols.length
    || new Set(expected.map(s => s.toUpperCase())).size !== expected.length
    || sortedJson([...symbols].sort()) !== sortedJson([...expected].sort())) {
    throw new Error('atomic_shadow_full_universe_coverage_missing')
  }
}

/** The live producer and historical reader must enforce the SAME original
 * weight-owner parity as shadow substitution. Valid hashes are not sufficient. */
async function verifyOriginalWeightBaseline(specs: StrategySpec[], options: AtomicShadowOptions,
  source: StrategyProductionWeightSource) {
  const baseline = await replayStrategyWeightSource(source)
  if (sortedJson(strictSpecs([...baseline.inputs.strategies])) !== sortedJson(strictSpecs(specs))
    || sortedJson(baseline.weights.routingWeights) !== sortedJson(options.productionStrategyWeights)
    || sortedJson(baseline.weights.evaluationWeights) !== sortedJson(options.strategyWeights)
    || baseline.weights.performanceWeightOwner !== options.performanceWeightOwner)
    throw new Error('atomic_shadow_original_weight_baseline_mismatch')
}

export async function buildLayer1WithAtomicSource<T extends StrategyCandidatePoolCandidate>(input: {
  universe: T[]; specs: StrategySpec[]; options: AtomicShadowOptions;
  signalDate: string; producerRunId: string; observedAt: string;
  productionWeightSource?: StrategyProductionWeightSource;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.signalDate) || !input.producerRunId
    || !/(Z|[+-]\d{2}:\d{2})$/.test(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error('atomic_shadow_source_identity_missing')
  }
  const frozen = JSON.parse(sortedJson(input)) as typeof input
  if (frozen.productionWeightSource) {
    if (frozen.productionWeightSource.inputs.knowledgeCutoffDate >= frozen.signalDate)
      throw new Error('atomic_shadow_weight_source_not_predecision')
    await verifyOriginalWeightBaseline(frozen.specs, frozen.options, frozen.productionWeightSource)
  }
  validateUniverse(frozen.universe.map(row => row.symbol), frozen.universe.map(row => row.symbol))
  const replacements = enumerateAtomicShadowReplacements(frozen.specs, frozen.options)
  const plan = buildLayer1StrategyBreadthPlan(frozen.universe, frozen.specs, frozen.options)
  // Store inputs once in the EXISTING canonical R2 artifact, not every symbol
  // row or D1 metadata. Copy before exposing the formal output to later overlays.
  const source = { schema_version: 'atomic-strategy-source-v1' as const,
    signal_date: input.signalDate, producer_run_id: input.producerRunId, observed_at: input.observedAt,
    inputs: JSON.parse(sortedJson(input)), expected_universe_symbols: input.universe.map(row => row.symbol),
    baseline_checksum: await checksum(plan),
    replacements,
    production_effect: false as const, promotion_allowed: false as const, nav_maturity_credit: 0 as const }
  return { plan, source: { ...source, source_checksum: await checksum(source) } }
}

export type AtomicStrategySource = Awaited<ReturnType<typeof buildLayer1WithAtomicSource>>['source'] & {
  post_overlay?: AtomicPostOverlayInputs
}

/** Original policy and daily observations travel together, but have different
 * identities. Never use the daily universe/teacher/weight hash as a new strategy.
 * Unknown fields remain policy; only named inputs of the existing router below
 * are classified as daily observations. This does not change their consumption.
 */
export async function buildAtomicPolicyContext(source: AtomicStrategySource) {
  const policy = { specs: strictSpecs(source.inputs.specs), options: structuredClone(source.inputs.options) }
  const stableOptions = JSON.parse(sortedJson(policy.options)) as Record<string, unknown>
  for (const key of ['regime', 'strategyPortfolioMetrics', 'strategySimilarityGraphEvidence',
    'runtimeTeacherEvidence', 'previousSlateSymbols']) delete stableOptions[key]
  if (['formal_evidence_owner', 'ple_portfolio_metrics'].includes(String(stableOptions.performanceWeightOwner))) {
    delete stableOptions.strategyWeights
    delete stableOptions.productionStrategyWeights
  }
  const identity = { schema_version: 'atomic-policy-identity-v1' as const,
    specs: structuredClone(policy.specs), options: stableOptions }
  const body = { schema_version: 'atomic-policy-context-v1' as const,
    source_checksum: source.source_checksum, policy, identity, policy_checksum: await checksum(identity) }
  return { ...body, context_checksum: await checksum(body) }
}

function validatePostOverlayTimes(inputs: AtomicPostOverlayInputs): void {
  const end = Date.parse(inputs.completed_at)
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(inputs.completed_at) || !Number.isFinite(end)) {
    throw new Error('atomic_shadow_post_overlay_time_invalid')
  }
  for (const records of Object.values(inputs.observations)) for (const record of records) {
    const start = Date.parse(record.started_at), completed = Date.parse(record.completed_at)
    if (![record.started_at, record.completed_at].every(value => /(Z|[+-]\d{2}:\d{2})$/.test(value))
      || ![start, completed].every(Number.isFinite) || start > completed || completed > end) {
      throw new Error('atomic_shadow_post_overlay_time_invalid')
    }
  }
}

/** Append once before canonical publication; never mutate a published source. */
export async function sealAtomicPostOverlaySource(source: AtomicStrategySource, inputs: AtomicPostOverlayInputs): Promise<AtomicStrategySource> {
  const { source_checksum, ...body } = source
  if (source.post_overlay || await checksum(body) !== source_checksum) throw new Error('atomic_shadow_source_already_sealed_or_corrupt')
  validateUniverse(inputs.universeSymbols, source.expected_universe_symbols)
  validatePostOverlayTimes(inputs)
  if (inputs.signalDate !== source.signal_date || inputs.schema_version !== 'atomic-post-overlay-inputs-v2'
    || inputs.effect_scope !== 'post_route_overlay_and_core_seed' || inputs.downstream_status !== 'requires_l2_ml'
    || inputs.promotion_allowed !== false || inputs.production_effect !== false || inputs.nav_maturity_credit !== 0
    || !Number.isFinite(Date.parse(inputs.completed_at))) throw new Error('atomic_shadow_post_overlay_identity_invalid')
  const next = { ...JSON.parse(sortedJson(body)), post_overlay: JSON.parse(sortedJson(inputs)) }
  return { ...next, source_checksum: await checksum(next) }
}

/** Proves only the acknowledged PRE-ML write request, not persisted ML-enriched
 * rows or candidate execution. Never obtain replacement inputs from live Core.
 */
export async function replayFrozenCoreSeeds(inputs?: AtomicPostOverlayInputs) {
  const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason })
  if (!inputs || inputs.schema_version === 'atomic-post-overlay-inputs-v1') return unavailable('legacy_core_seed_not_captured')
  if (inputs.schema_version !== 'atomic-post-overlay-inputs-v2'
    || inputs.effect_scope !== 'post_route_overlay_and_core_seed' || inputs.downstream_status !== 'requires_l2_ml') {
    throw new Error('atomic_shadow_post_overlay_identity_invalid')
  }
  const contextRows = inputs.observations.core_seed_context ?? []
  const receiptRows = inputs.observations.core_seed_materialization ?? []
  if (!contextRows.length || !receiptRows.length) return unavailable('core_seed_observation_missing')
  if (contextRows.length !== 1 || receiptRows.length !== 1) throw new Error('atomic_shadow_core_seed_observation_ambiguous')
  if (contextRows[0].status !== 'captured' || receiptRows[0].status !== 'captured') return unavailable('core_seed_observation_unverified')
  if (Date.parse(contextRows[0].completed_at) > Date.parse(receiptRows[0].started_at)) {
    throw new Error('atomic_shadow_core_seed_observation_order_invalid')
  }
  const context = contextRows[0].value as { context?: unknown } | undefined
  const receipt = receiptRows[0].value as { owner?: string; write_status?: string; rows?: unknown } | undefined
  if (receipt?.owner !== 'screener_pre_ml_seed_request' || receipt.write_status !== 'acknowledged'
    || !Array.isArray(receipt.rows) || !Array.isArray(inputs.finalSeed)) {
    throw new Error('atomic_shadow_core_seed_receipt_invalid')
  }
  const candidates = inputs.finalSeed as CoreSeedCandidate[]
  const symbols = candidates.map(row => row?.symbol)
  validateUniverse(symbols, symbols)
  if (symbols.some(symbol => !inputs.formalSymbols.includes(symbol))) throw new Error('atomic_shadow_core_seed_scope_invalid')
  const rows = materializeScreenerCoreSeeds(candidates, decodeScreenerCoreSeedContext(context?.context))
  // scoreComponents is a JSON column. Source canonicalization orders object
  // keys, but an acknowledged JSON string retains its original key order.
  const semanticRows = (value: unknown[]) => value.map(item => {
    const row = structuredClone(item) as ReturnType<typeof materializeScreenerCoreSeeds>[number]
    if (typeof row?.seed?.row?.scoreComponents === 'string') {
      row.seed.row.scoreComponents = sortedJson(JSON.parse(row.seed.row.scoreComponents))
    }
    return row
  })
  const replayChecksum = await checksum(semanticRows(rows))
  if (replayChecksum !== await checksum(semanticRows(receipt.rows))) throw new Error('atomic_shadow_core_seed_replay_mismatch')
  return { status: 'matched' as const, scope: 'acknowledged_pre_ml_seed_request' as const,
    rows, replay_checksum: replayChecksum }
}

/** Caller must first verify the enclosing canonical artifact and its checksum. */
export async function validateAtomicStrategySource(source: AtomicStrategySource,
  identity: { signalDate: string; producerRunId: string; artifactCreatedAt: string; decisionDeadline: string }) {
  const { source_checksum, ...body } = source
  const observed = Date.parse(source.observed_at), published = Date.parse(identity.artifactCreatedAt)
  const deadline = Date.parse(identity.decisionDeadline)
  if (source.schema_version !== 'atomic-strategy-source-v1' || await checksum(body) !== source_checksum
    || source.signal_date !== identity.signalDate || source.producer_run_id !== identity.producerRunId
    || source.inputs.signalDate !== source.signal_date || source.inputs.producerRunId !== source.producer_run_id
    || source.inputs.observedAt !== source.observed_at
    || [source.observed_at, identity.artifactCreatedAt, identity.decisionDeadline].some(value => !/(Z|[+-]\d{2}:\d{2})$/.test(value))
    || ![observed, published, deadline].every(Number.isFinite) || observed > published || published >= deadline
    || source.production_effect !== false || source.promotion_allowed !== false || source.nav_maturity_credit !== 0) {
    throw new Error('atomic_shadow_source_lineage_or_time_invalid')
  }
  if (source.post_overlay) {
    validatePostOverlayTimes(source.post_overlay)
    const at = Date.parse(source.post_overlay.completed_at)
    if (!Number.isFinite(at) || at < observed || at > published) throw new Error('atomic_shadow_post_overlay_time_invalid')
    validateUniverse(source.post_overlay.universeSymbols, source.expected_universe_symbols)
    if (source.post_overlay.signalDate !== source.signal_date) throw new Error('atomic_shadow_post_overlay_identity_invalid')
  }
  if (source.inputs.productionWeightSource
    && source.inputs.productionWeightSource.inputs.knowledgeCutoffDate >= source.signal_date)
    throw new Error('atomic_shadow_weight_source_not_predecision')
  if (source.inputs.productionWeightSource)
    await verifyOriginalWeightBaseline(source.inputs.specs, source.inputs.options, source.inputs.productionWeightSource)
  if (sortedJson(source.replacements) !== sortedJson(enumerateAtomicShadowReplacements(source.inputs.specs, source.inputs.options))) {
    throw new Error('atomic_shadow_source_population_mismatch')
  }
  const baseline = buildLayer1StrategyBreadthPlan(structuredClone(source.inputs.universe),
    structuredClone(source.inputs.specs), structuredClone(source.inputs.options))
  if (await checksum(baseline) !== source.baseline_checksum) throw new Error('atomic_shadow_source_replay_mismatch')
}

export async function replayAtomicStrategySource(source: AtomicStrategySource, replacement: AtomicShadowReplacement,
  identity: { signalDate: string; producerRunId: string; artifactCreatedAt: string; decisionDeadline: string },
  continuationDefinitionChecksum?: string) {
  await validateAtomicStrategySource(source, identity)
  const source_checksum = source.source_checksum
  const result = await buildAtomicStrategyShadow({ ...source.inputs,
    expectedUniverseSymbols: source.expected_universe_symbols, replacement, continuationDefinitionChecksum })
  if (await checksum(result.baseline) !== source.baseline_checksum) {
    throw new Error('atomic_shadow_source_replay_mismatch')
  }
  if (source.post_overlay) validateUniverse(source.post_overlay.formalSymbols, result.baseline_symbols)
  let postOverlayReplay: { status: 'unavailable'; reason: string } | {
    status: 'baseline_matched_candidate_replayed'; baseline: ReturnType<typeof replayFrozenPostRoute>;
    candidate: ReturnType<typeof replayFrozenPostRoute>;
  } = { status: 'unavailable', reason: 'post_overlay_not_captured' }
  if (source.post_overlay) {
    const baseline = replayFrozenPostRoute({ packet: source.post_overlay, universe: source.inputs.universe,
      plan: result.baseline, specs: result.baseline_policy.specs })
    if (baseline.status === 'replayed') {
      if (sortedJson(baseline.finalSeed) !== sortedJson(source.post_overlay.finalSeed)
        || sortedJson([...baseline.safetyExcludedSymbols].sort()) !== sortedJson([...source.post_overlay.safetyExcludedSymbols].sort())) {
        throw new Error('atomic_shadow_post_overlay_replay_mismatch')
      }
      const candidate = replayFrozenPostRoute({ packet: source.post_overlay, universe: source.inputs.universe,
        plan: result.candidate, specs: result.candidate_policy.specs })
      postOverlayReplay = candidate.status === 'replayed'
        ? { status: 'baseline_matched_candidate_replayed', baseline, candidate }
        : { status: 'unavailable', reason: candidate.reason }
    } else postOverlayReplay = baseline
  }
  const coreSeedReplay = await replayFrozenCoreSeeds(source.post_overlay)
  const candidateCoreReplay = coreSeedReplay.status === 'matched' && source.post_overlay
    && postOverlayReplay.status === 'baseline_matched_candidate_replayed' && postOverlayReplay.candidate.status === 'replayed'
    ? await replayFrozenCandidateCoreSeeds(source.post_overlay, postOverlayReplay.candidate.finalSeed, replacement)
    : { status: 'unavailable' as const, reason: 'candidate_core_requires_baseline_and_post_route_replay' }
  return { ...result, source_checksum, core_seed_replay: coreSeedReplay, candidate_core_replay: candidateCoreReplay,
    post_overlay_replay: postOverlayReplay,
    ...(source.post_overlay ? { post_overlay: structuredClone(source.post_overlay) } : {}) }
}

export async function buildAtomicStrategyShadow<T extends StrategyCandidatePoolCandidate>(input: {
  universe: T[]
  expectedUniverseSymbols: string[]
  specs: StrategySpec[]
  options: AtomicShadowOptions
  replacement: AtomicShadowReplacement
  continuationDefinitionChecksum?: string
  productionWeightSource?: StrategyProductionWeightSource
}) {
  const frozen = structuredClone(input)
  const symbols = frozen.universe.map(row => row.symbol)
  validateUniverse(symbols, frozen.expectedUniverseSymbols)
  const specs = strictSpecs(frozen.specs)
  const admitted = enumerateAtomicShadowReplacements(specs, frozen.options)
    .some(pair => sortedJson(pair) === sortedJson(frozen.replacement))
  const { candidateId, incumbentId } = frozen.replacement
  const candidateSpec = specs.find(spec => spec.id === candidateId)
  const incumbentSpec = specs.find(spec => spec.id === incumbentId)
  const definition = { replacement: frozen.replacement, candidate: candidateSpec, incumbent: incumbentSpec }
  const legacyChecksum = await checksum(definition)
  // Keep previously registered transfer experiments exact; never relabel their
  // maturity as evidence for the corrected daily-owner intervention.
  const originalWeights = Boolean(frozen.productionWeightSource)
    && frozen.continuationDefinitionChecksum !== legacyChecksum
  const definitionChecksum = originalWeights
    ? await checksum({ ...definition, weight_policy_version: STRATEGY_PRODUCTION_WEIGHT_KERNEL }) : legacyChecksum
  const continued = frozen.continuationDefinitionChecksum !== undefined
  if (continued && (frozen.continuationDefinitionChecksum !== definitionChecksum
    || candidateSpec?.status !== 'candidate' || candidateSpec.ownerType !== 'strategy' || candidateSpec.promotionStatus !== 'candidate'
    || incumbentSpec?.status !== 'active' || incumbentSpec.ownerType !== 'strategy' || incumbentSpec.promotionStatus !== 'production'
    || candidateSpec.version !== frozen.replacement.candidateVersion || incumbentSpec.version !== frozen.replacement.incumbentVersion
    || candidateId === incumbentId || frozen.options.productionStrategyWeights[candidateId] !== 0)) {
    throw new Error('atomic_shadow_continuation_definition_changed')
  }
  if (!admitted && !continued) {
    throw new Error('atomic_shadow_replacement_not_in_structural_population')
  }
  const baseline = buildLayer1StrategyBreadthPlan(structuredClone(frozen.universe), structuredClone(specs), structuredClone(frozen.options))
  const alternativeSpecs = specs.map(spec => spec.id === candidateId
    ? { ...spec, status: 'active' as const, promotionStatus: 'production' as const }
    : spec.id === incumbentId ? { ...spec, status: 'candidate' as const, promotionStatus: 'candidate' as const } : spec)
  const alternativeOptions = structuredClone(frozen.options)
  if (originalWeights) {
    await verifyOriginalWeightBaseline(specs, frozen.options, frozen.productionWeightSource!)
    const replaced = await replayStrategyWeightSource(frozen.productionWeightSource!, frozen.replacement)
    alternativeOptions.productionStrategyWeights = replaced.weights.routingWeights
    alternativeOptions.strategyWeights = replaced.weights.evaluationWeights
    alternativeOptions.performanceWeightOwner = replaced.weights.performanceWeightOwner
  } else {
    alternativeOptions.productionStrategyWeights[candidateId] = frozen.options.productionStrategyWeights[incumbentId]
    alternativeOptions.productionStrategyWeights[incumbentId] = 0
  }
  const candidate = buildLayer1StrategyBreadthPlan(structuredClone(frozen.universe), alternativeSpecs, alternativeOptions)
  const baselineSymbols = baseline.breadthPool.map(row => row.symbol)
  const candidateSymbols = candidate.breadthPool.map(row => row.symbol)
  const baselineSet = new Set(baselineSymbols), candidateSet = new Set(candidateSymbols)
  const requiredPredictionSymbols = [...new Set([...baselineSymbols, ...candidateSymbols])].sort()
  return {
    schema_version: 'atomic-strategy-shadow-slate-v1' as const,
    replacement: frozen.replacement,
    input_checksum: await checksum(frozen),
    // This identifies the intervention, NOT the whole executable experiment.
    // The eventual native pair must also pin its model/engine/configuration.
    // Daily market/teacher/weight observations must never masquerade as a new
    // strategy definition, but remain sealed in the runtime context below.
    replacement_definition_checksum: definitionChecksum,
    ...(originalWeights ? { weight_policy_version: STRATEGY_PRODUCTION_WEIGHT_KERNEL } : {}),
    runtime_context_checksum: await checksum({ specs, options: frozen.options,
      ...(originalWeights ? { productionWeightSource: frozen.productionWeightSource } : {}) }),
    source_universe_count: symbols.length,
    baseline, candidate, baseline_symbols: baselineSymbols, candidate_symbols: candidateSymbols,
    baseline_policy: { specs, options: frozen.options },
    candidate_policy: { specs: alternativeSpecs, options: alternativeOptions },
    added_symbols: candidateSymbols.filter(symbol => !baselineSet.has(symbol)),
    removed_symbols: baselineSymbols.filter(symbol => !candidateSet.has(symbol)),
    required_prediction_symbols: requiredPredictionSymbols,
    missing_incumbent_prediction_symbols: requiredPredictionSymbols.filter(symbol => !baselineSet.has(symbol)),
    effect_scope: 'strategy_admission_and_route_recomputed' as const,
    execution_status: 'requires_frozen_ml_and_paired_execution' as const,
    production_effect: false as const, promotion_allowed: false as const, nav_maturity_credit: 0 as const,
  }
}
