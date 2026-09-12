import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAtomicStrategyShadow, enumerateAtomicShadowReplacements, buildLayer1WithAtomicSource, replayAtomicStrategySource, buildAtomicPolicyContext } from './atomicStrategyShadow'
import { buildLayer1StrategyBreadthPlan, type StrategyCandidatePoolCandidate } from './strategyCandidatePool'
import { DEFAULT_STRATEGY_SPECS, type StrategySpec } from './strategySpec'
import { resolveRuntimeStrategyWeights } from './strategyProductionPolicyStore'
import { materializePostOverlayStrategySeed } from './screenerPostOverlaySeed'
import { buildFormalOwnerWeightInputs } from './strategyProductionPolicyService'
import { buildStrategyProductionContributionFirewall } from './strategyProductionContributionFirewall'

const original: StrategySpec = {
  id: 'original', version: 'strategy-spec-v1', name: 'incumbent', status: 'active', owner: 'strategy',
  ownerType: 'strategy', promotionStatus: 'production', familyId: 'TREND_RECLAIM_CONTINUATION', variantId: 'original',
  alphaBucket: 'trend_following', supportedRegimes: ['bull'], thesis: 'synthetic test',
  thresholds: { minFactorSignals: { original: .5 } },
  candidatePolicy: { poolQuota: 10, costBudget: 10, evidenceRequirements: [], maxMlShare: .2 },
  riskNotes: [], createdBy: 'p5_strategy_governance',
}
const challenger: StrategySpec = { ...original, id: 'challenger', name: 'candidate', variantId: 'challenger',
  status: 'candidate', promotionStatus: 'candidate', thresholds: { minFactorSignals: { challenger: .5 } } }
function stock(symbol: string, original: number, challenger: number): StrategyCandidatePoolCandidate {
  return { symbol, eligible_for_ml: 1, market_segment: 'LISTED', current_price: 50,
    raw_signals: { close: 50, closeAboveMa20Pct: .03, closeAboveMa60Pct: .02, volumeExpansion20: 1.2,
      return20d: .05, factorSignals: { original, challenger } },
    score_components: { version: 'score_v2', finalScore: 60,
      components: { chipFlow: 20, technicalStructure: 20, fundamentalQuality: 10, mlEdge: 12, newsTheme: 2 },
      technicalBreakdown: { trendStructure: 6, volatilityStructure: 4, reversalExtreme: 4, volumeConfirmation: 4, executionRisk: 1 },
      seedComponents: { screenerMomentumSeed20: 10 } } }
}
function fixture() {
  const universe = [stock('base-only', .9, .1), stock('candidate-only', .1, .9), stock('both', .9, .9)]
  const options = { targetSize: 1, coarseMlQueueSize: 1, regime: 'bull',
    strategyWeights: { original: 1, challenger: 1 }, productionStrategyWeights: { original: 1, challenger: 0 } }
  return { universe, expectedUniverseSymbols: universe.map(row => row.symbol), specs: [original, challenger], options,
    replacement: { candidateId: challenger.id, candidateVersion: challenger.version,
      incumbentId: original.id, incumbentVersion: original.version } }
}

test('Atomic transferred-weight evidence is not a grant for a different post-cutover daily policy', async () => {
  const input = fixture()
  const other: StrategySpec = { ...original, id: 'other', variantId: 'other', name: 'other' }
  const specs = [...input.specs, other]
  const evidenceFusion = { profiles: specs.map(spec => ({ strategy_id: spec.id,
    weight_multiplier: 1, performance_state: 'full' })) } as any
  const adaptiveWeights = { original: .6, challenger: .2, other: .4 }
  const runtime = (strategies: StrategySpec[], candidateReady = true) => {
    const gates = strategies.map(spec => ({ strategy_id: spec.id, decision: 'active_monitor' as const,
      allocation_eligible: spec.status === 'active' && (spec.id !== 'challenger' || candidateReady) }))
    const weights = buildFormalOwnerWeightInputs({ strategies, gates: gates as any, adaptiveWeights, evidenceFusion })
    const state = buildStrategyProductionContributionFirewall({ knowledgeCutoffDate: '2026-09-09', strategies,
      gates: gates.map(gate => ({ ...gate, contribution_mode: weights.contributionModes[gate.strategy_id] ?? 'blocked' })),
      base: { source: 'adaptive_strategy_policy_v2', weights: weights.weights,
        evidence_owner: { version: 'strategy-evidence-owner-fusion-v3', checksum: 'a'.repeat(64),
          weight_effect: 'neutral_until_immutable_calibration', ready_profile_count: 3 } } })
    return resolveRuntimeStrategyWeights(strategies.map(spec => spec.id), { state, checksum: 'fixture', created_at: 'fixture' })
  }
  const baseline = runtime(specs)
  const shadow = await buildAtomicStrategyShadow({ ...input, specs, options: { ...input.options,
    strategyWeights: baseline.evaluationWeights, productionStrategyWeights: baseline.routingWeights,
    performanceWeightOwner: baseline.performanceWeightOwner } })
  // Re-running the ORIGINAL formal owner after only changing registry statuses
  // is not the tested transfer, even when the candidate is fully evidence-ready.
  const next = runtime(shadow.candidate_policy.specs)
  assert.equal(shadow.candidate_policy.options.productionStrategyWeights.challenger, 1.2)
  assert.equal(next.routingWeights.challenger, .666667)
  assert.equal(next.allocationWeights.challenger, .333333333333)
  assert.equal(runtime(shadow.candidate_policy.specs, false).routingWeights.challenger, 0)
  assert.notDeepEqual(next.routingWeights, shadow.candidate_policy.options.productionStrategyWeights)
  // Synthetic policy semantics only, no return, maturity or investment claim.
  console.log('NAV_ATOMIC_WEIGHT_PARITY_DIAGNOSTIC=' + JSON.stringify({
    scope: 'synthetic_policy_semantics_not_returns', tested_candidate_route_weight: 1.2,
    registry_only_next_daily_route_weight: next.routingWeights.challenger,
    registry_only_next_daily_allocation_weight: next.allocationWeights.challenger,
    candidate_not_ready_next_daily_route_weight: 0, adoption_verified: false,
  }))
})

test('Atomic policy identity advances observations without resetting the strategy definition', async () => {
  const input = fixture()
  const { source } = await buildLayer1WithAtomicSource({ ...input, signalDate: '2026-09-09',
    producerRunId: 'policy-fixture', observedAt: '2026-09-09T12:00:00Z',
    options: { ...input.options, performanceWeightOwner: 'formal_evidence_owner' } })
  const before = structuredClone(source)
  const original = await buildAtomicPolicyContext(source)
  const next = structuredClone(source)
  next.source_checksum = 'a'.repeat(64)
  next.inputs.options.regime = 'bear'
  next.inputs.options.productionStrategyWeights.original = .4
  next.inputs.options.strategyWeights.challenger = 0
  next.inputs.options.runtimeTeacherEvidence = { 'base-only': { confidence: .3 } }
  next.inputs.options.previousSlateSymbols = ['candidate-only']
  const changed = await buildAtomicPolicyContext(next)
  assert.equal(changed.policy_checksum, original.policy_checksum)
  assert.notEqual(changed.context_checksum, original.context_checksum)
  assert.equal(changed.policy.options.productionStrategyWeights.original, .4)
  assert.deepEqual(source, before)
  for (const mutate of [
    (value: typeof next) => { value.inputs.specs[0].thresholds.minFactorSignals = { original: .8 } },
    (value: typeof next) => { value.inputs.options.targetSize += 1 },
    (value: typeof next) => { value.inputs.options.promotedRouteCalibration = { runId: 'new', routeVersion: 'new', routeFloor: .3 } },
    (value: typeof next) => { (value.inputs.options as any).unknownFuturePolicy = true },
  ]) {
    const different = structuredClone(next); mutate(different)
    assert.notEqual((await buildAtomicPolicyContext(different)).policy_checksum, original.policy_checksum)
  }
  const unowned = structuredClone(source); delete unowned.inputs.options.performanceWeightOwner
  const unownedBefore = await buildAtomicPolicyContext(unowned)
  unowned.inputs.options.productionStrategyWeights.original = .4
  assert.notEqual((await buildAtomicPolicyContext(unowned)).policy_checksum, unownedBefore.policy_checksum)
})

test('Atomic breadth feeds the SAME post-overlay seed owner with each arm own specs', async () => {
  const input = fixture()
  const shadow = await buildAtomicStrategyShadow(input)
  const updated = input.universe.filter(row => row.symbol !== 'both').map(row => ({
    ...row, score: 42, strategy_watch_points: ['post-overlay'],
    strategy_matches: [{ specId: 'historical', alphaBucket: 'trend_following', status: 'active',
      label: 'historical match', reason: 'original five-field snapshot' }],
  }))
  const before = structuredClone({ shadow, updated })
  const alternativeSpecs = input.specs.map(spec => spec.id === 'challenger'
    ? { ...spec, status: 'active' as const, promotionStatus: 'production' as const }
    : { ...spec, status: 'candidate' as const, promotionStatus: 'candidate' as const })
  const formal = materializePostOverlayStrategySeed(shadow.baseline.coarseQueue, updated, input.specs, { regime: 'bull' })
  const candidate = materializePostOverlayStrategySeed(shadow.candidate.coarseQueue, updated, alternativeSpecs, { regime: 'bull' })
  assert.deepEqual(formal.map(row => row.symbol), ['base-only'])
  assert.deepEqual(candidate.map(row => row.symbol), ['candidate-only'])
  assert.deepEqual(formal[0].strategy_pool_ids, ['original'])
  assert.deepEqual(candidate[0].strategy_pool_ids, ['challenger'])
  assert.equal(formal[0].score, 42)
  assert.equal(candidate[0].score, 42)
  assert(formal[0].strategy_watch_points?.includes('post-overlay'))
  assert.equal(Object.hasOwn(formal[0].strategy_matches!.find(m => m.specId === 'historical')!, 'matchStrength'), false)
  assert.deepEqual({ shadow, updated }, before)
  // An observer/top-up/no-owner cannot become a formal seed merely because an
  // updated score exists. Score ranking never fills the removed common stock.
  const rejected = shadow.baseline.coarseQueue.flatMap(row => [
    { ...row, strategy_pool_decision: 'research_only_queue' as const },
    { ...row, strategy_pool_fallback_source: 'raw_signal_top_up' },
    { ...row, strategy_pool_ids: [] },
  ])
  assert.deepEqual(materializePostOverlayStrategySeed(rejected, updated, input.specs, {}), [])
})

test('Atomic replacement uses full original breadth kernel, no current-pick-only universe or Top-K', async () => {
  const input = fixture(), before = structuredClone(input)
  const result = await buildAtomicStrategyShadow(input)
  assert.deepEqual(result.baseline, buildLayer1StrategyBreadthPlan(input.universe, input.specs, input.options))
  assert.deepEqual(result.baseline_symbols.sort(), ['base-only', 'both'])
  assert.deepEqual(result.candidate_symbols.sort(), ['both', 'candidate-only'])
  assert.deepEqual(result.added_symbols, ['candidate-only'])
  assert.deepEqual(result.removed_symbols, ['base-only'])
  assert.deepEqual(result.missing_incumbent_prediction_symbols, ['candidate-only'])
  assert.equal(result.source_universe_count, 3)
  assert.equal(result.nav_maturity_credit, 0)
  assert.equal(result.promotion_allowed, false)
  assert.deepEqual(input, before, 'shadow cannot mutate registry, policy or formal rows')
  assert.equal((await buildAtomicStrategyShadow(input)).input_checksum, result.input_checksum)
})

test('no-hit and identical slates remain in the structural observation population', async () => {
  for (const mode of ['no-hit', 'identical']) {
    const input = fixture()
    input.universe = input.universe.map(row => stock(row.symbol, mode === 'no-hit' ? .1 : .9, mode === 'no-hit' ? .1 : .9))
    assert.equal(enumerateAtomicShadowReplacements(input.specs, input.options).length, 1)
    const result = await buildAtomicStrategyShadow(input)
    assert.deepEqual(result.added_symbols, [])
    assert.deepEqual(result.removed_symbols, [])
    assert.equal(result.execution_status, 'requires_frozen_ml_and_paired_execution')
  }
})

test('cannot promote observer, retired, stale spec version, missing weights or partial universe', async () => {
  for (const fault of ['observer', 'retired', 'version', 'missing-weight', 'partial', 'duplicate', 'nonfinite']) {
    const input = structuredClone(fixture())
    if (fault === 'observer') input.specs[1].ownerType = 'observe'
    if (fault === 'retired') input.specs[1].status = 'retired'
    if (fault === 'version') input.replacement.candidateVersion = 'stale'
    if (fault === 'missing-weight') delete (input.options.productionStrategyWeights as Record<string, number>).challenger
    if (fault === 'partial') input.universe.pop()
    if (fault === 'duplicate') input.universe[1].symbol = input.universe[0].symbol
    if (fault === 'nonfinite') input.universe[0].current_price = Number.NaN
    await assert.rejects(buildAtomicStrategyShadow(input), /atomic_shadow_/)
  }
})

test('market restrictions and regime eligibility remain owned by the real kernel', async () => {
  const input = fixture()
  input.universe[1].restricted = true
  let result = await buildAtomicStrategyShadow(input)
  assert.deepEqual(result.added_symbols, [])
  input.options.regime = 'bear'
  result = await buildAtomicStrategyShadow(input)
  assert.deepEqual(result.baseline_symbols, [])
  assert.deepEqual(result.candidate_symbols, [])
})

test('formal source capture equals the original kernel and freezes inputs before later overlays', async () => {
  const input = fixture(), originalInput = structuredClone(input)
  const captured = await buildLayer1WithAtomicSource({ ...input,
    signalDate: '2026-09-09', producerRunId: 'fixture-run', observedAt: '2026-09-09T12:00:00Z' })
  assert.deepEqual(captured.plan, buildLayer1StrategyBreadthPlan(input.universe, input.specs, input.options))
  assert.deepEqual(input, originalInput)
  const identity = { signalDate: '2026-09-09', producerRunId: 'fixture-run',
    artifactCreatedAt: '2026-09-09T12:01:00Z', decisionDeadline: '2026-09-09T23:15:00Z' }
  const replay = await replayAtomicStrategySource(captured.source, input.replacement, identity)
  assert.deepEqual(replay.added_symbols, ['candidate-only'])
  captured.plan.breadthPool[0].symbol = 'later-mutation'
  input.universe[0].symbol = 'outside-mutation'
  assert.deepEqual(await replayAtomicStrategySource(captured.source, originalInput.replacement, identity), replay)
  for (const change of [{ producerRunId: 'other-run' }, { signalDate: '2026-09-08' },
    { artifactCreatedAt: '2026-09-09T11:00:00Z' }, { decisionDeadline: '2026-09-09T12:01:00Z' },
    { artifactCreatedAt: '2026-09-09T12:01:00' }]) {
    await assert.rejects(replayAtomicStrategySource(captured.source, originalInput.replacement, { ...identity, ...change }), /atomic_shadow_/)
  }
  const corrupt = structuredClone(captured.source)
  corrupt.inputs.specs[1].thresholds = { minPrice: 0 }
  await assert.rejects(replayAtomicStrategySource(corrupt, originalInput.replacement, identity), /atomic_shadow_/)
})

test('daily inputs are sealed separately from the exact replacement definition', async () => {
  const input = fixture(), baseline = await buildAtomicStrategyShadow(input)
  const next = structuredClone(input)
  next.options.regime = 'bear'
  next.options.productionStrategyWeights.original = .75
  const daily = await buildAtomicStrategyShadow({ ...next, options: { ...next.options,
    previousSlateSymbols: ['both'], runtimeTeacherEvidence: { both: { ml: 70 } } } })
  assert.equal(daily.replacement_definition_checksum, baseline.replacement_definition_checksum)
  assert.notEqual(daily.runtime_context_checksum, baseline.runtime_context_checksum)
  assert.notEqual(daily.input_checksum, baseline.input_checksum)
  assert.deepEqual(daily.baseline_symbols, [])
  next.specs[1] = { ...next.specs[1], thresholds: { minFactorSignals: { challenger: .6 } } }
  assert.notEqual((await buildAtomicStrategyShadow(next)).replacement_definition_checksum,
    baseline.replacement_definition_checksum, 'threshold edits with an unchanged version are not the same candidate')
})

test('a missing weight cannot silently remove a contrast; explicit zero remains valid', () => {
  for (const field of ['strategyWeights', 'productionStrategyWeights'] as const) {
    for (const bad of [undefined, null, -1, NaN, Infinity, '1']) {
      const input = fixture()
      ;(input.options[field] as Record<string, unknown>).challenger = bad
      assert.throws(() => enumerateAtomicShadowReplacements(input.specs, input.options), /weight_missing_or_invalid/)
    }
  }
  const input = fixture()
  input.options.strategyWeights.challenger = 0
  assert.deepEqual(enumerateAtomicShadowReplacements(input.specs, input.options), [])
})

test('registered exact Atomic contrast continues on zero weights without changing actual weights', async () => {
  const originalInput = fixture()
  const first = await buildAtomicStrategyShadow(originalInput)
  for (const mode of ['candidate', 'incumbent', 'production', 'all']) {
    const input = structuredClone(originalInput)
    if (mode === 'candidate' || mode === 'all') input.options.strategyWeights.challenger = 0
    if (mode === 'incumbent' || mode === 'all') input.options.strategyWeights.original = 0
    if (mode === 'production' || mode === 'all') input.options.productionStrategyWeights.original = 0
    const before = structuredClone(input)
    assert.deepEqual(enumerateAtomicShadowReplacements(input.specs, input.options), [], 'new admission stays unchanged')
    const continued = await buildAtomicStrategyShadow({ ...input,
      continuationDefinitionChecksum: first.replacement_definition_checksum })
    assert.equal(continued.replacement_definition_checksum, first.replacement_definition_checksum)
    assert.deepEqual(continued.baseline, buildLayer1StrategyBreadthPlan(input.universe, input.specs, input.options))
    assert.equal(continued.candidate_policy.options.strategyWeights.challenger, input.options.strategyWeights.challenger)
    assert.equal(continued.candidate_policy.options.productionStrategyWeights.challenger, input.options.productionStrategyWeights.original)
    assert.equal(continued.production_effect, false)
    assert.equal(continued.nav_maturity_credit, 0)
    assert.deepEqual(input, before)
    await assert.rejects(buildAtomicStrategyShadow({ ...input, continuationDefinitionChecksum: 'a'.repeat(64) }), /atomic_shadow_/)
  }
})

test('full real registry and actual runtime weight resolver retain original formal output', async () => {
  const specs = structuredClone(DEFAULT_STRATEGY_SPECS)
  const ids = specs.filter(s => s.status !== 'retired').map(s => s.id)
  const weights = resolveRuntimeStrategyWeights(ids, null)
  const input = { universe: fixture().universe, specs,
    options: { ...fixture().options, strategyWeights: weights.evaluationWeights,
      productionStrategyWeights: weights.routingWeights, performanceWeightOwner: weights.performanceWeightOwner },
    signalDate: '2026-09-09', producerRunId: 'registry-fixture', observedAt: '2026-09-09T12:00:00Z' }
  const captured = await buildLayer1WithAtomicSource(input)
  assert.deepEqual(captured.plan, buildLayer1StrategyBreadthPlan(input.universe, specs, input.options))
  assert.deepEqual(captured.source.replacements, [], 'no formal policy remains abstention, not fabricated equal weights')
  assert.equal(captured.source.inputs.specs.length, specs.length)
  input.options.productionStrategyWeights = Object.fromEntries(specs.filter(s => s.status !== 'retired')
    .map(s => [s.id, s.status === 'active' && s.ownerType === 'strategy' && s.promotionStatus === 'production' ? 1 : 0]))
  const activeCapture = await buildLayer1WithAtomicSource(input)
  assert.deepEqual(activeCapture.plan, buildLayer1StrategyBreadthPlan(input.universe, specs, input.options))
  assert.equal(activeCapture.source.inputs.specs.length, specs.length)
})

test('explicit empty source can replay, missing and duplicated source universe cannot', async () => {
  const input = fixture()
  const captured = await buildLayer1WithAtomicSource({ ...input, universe: [],
    signalDate: '2026-09-09', producerRunId: 'empty-fixture', observedAt: '2026-09-09T12:00:00Z' })
  const replay = await replayAtomicStrategySource(captured.source, input.replacement, {
    signalDate: '2026-09-09', producerRunId: 'empty-fixture',
    artifactCreatedAt: '2026-09-09T12:01:00Z', decisionDeadline: '2026-09-09T23:15:00Z' })
  assert.equal(replay.source_universe_count, 0)
  assert.deepEqual(replay.required_prediction_symbols, [])
  assert.equal(replay.nav_maturity_credit, 0)
  for (const universe of [undefined, [...input.universe, input.universe[0]], [stock(' ', 1, 1)]]) {
    await assert.rejects(buildLayer1WithAtomicSource({ ...captured.source.inputs, universe: universe as any }))
  }
})
