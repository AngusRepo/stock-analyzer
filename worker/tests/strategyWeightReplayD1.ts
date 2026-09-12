// Real original producer/reader/replay in private native D1. No return claims.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { DEFAULT_STRATEGY_SPECS, type StrategySpec } from '../src/lib/strategySpec'
import { buildStrategyAdaptivePolicyState, evaluateStrategyPromotionGate,
  type StrategyLearningSummary } from '../src/lib/strategyLearning'
import { listStrategyEvidenceProfiles } from '../src/lib/strategyEvidenceProfile'
import { refreshStrategyProductionContributionPolicy } from '../src/lib/strategyProductionPolicyService'
import { loadStrategyProductionPolicyBefore, resolveRuntimeStrategyWeights, sha256StrategyProductionPolicyPayload } from '../src/lib/strategyProductionPolicyStore'
import { captureStrategyWeightSource, replayStrategyWeightSource, resolveStrategyServingSpecs } from '../src/lib/strategyProductionWeightReplay'
import { evaluateStrategyEvidenceOwnerCalibration, STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION } from '../src/lib/strategyEvidenceOwnerCalibration'
import { buildAtomicStrategyShadow } from '../src/lib/atomicStrategyShadow'
import { buildLayer1WithAtomicSource, validateAtomicStrategySource } from '../src/lib/atomicStrategyShadow'
import { buildLayer1StrategyBreadthPlan } from '../src/lib/strategyCandidatePool'
import { atomicNavDigest } from '../src/lib/strategyAtomicNavReceipt'

const active = DEFAULT_STRATEGY_SPECS.find(spec => spec.status === 'active' && spec.ownerType === 'strategy')!
const specs: StrategySpec[] = [active,
  { ...active, id: 'weight-replay-candidate', variantId: 'weight-replay-candidate', status: 'candidate', promotionStatus: 'candidate' },
  { ...active, id: 'weight-replay-other', variantId: 'weight-replay-other' },
]
const replacement = { incumbentId: active.id, incumbentVersion: active.version,
  candidateId: specs[1].id, candidateVersion: specs[1].version }
const cutoff = '2026-09-09'

function originalPolicyInput(strategies = specs, candidateSamples = 45, day = cutoff) {
  const summary = { date: day, specs: strategies.map(spec => ({ ...spec, learning: {
    reward_owner: 'selection_edge_v4', rolling_evaluable_decisions: 76, rolling_decisions: 80,
    rolling_unavailable_decisions: 4, rolling_matched: 24, rolling_match_rate: .3,
    rolling_samples: spec.id === replacement.candidateId ? candidateSamples : 45,
    rolling_hit_rate: .6, rolling_avg_return_pct: .01, rolling_max_drawdown_pct: -.03,
    rolling_reward_dates: 12, rolling_date_return_lcb90: .001, decisions: 800,
  } })), promotion_gate: [], replacement_gate: { decisions: [], candidate_prefilters: [], evidence_status: 'pending' },
  } as unknown as StrategyLearningSummary
  summary.promotion_gate = evaluateStrategyPromotionGate(summary)
  return { knowledgeCutoffDate: day, strategies, gates: summary.promotion_gate,
    adaptiveState: buildStrategyAdaptivePolicyState(summary, { nowIso: day + 'T12:00:00Z' }) }
}

async function fixture(run: (db: D1Database) => Promise<void>) {
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("private") } }', d1Databases: ['LEARNING'] })
  try {
    const db = await mf.getD1Database('LEARNING') as unknown as D1Database
    const migration = readFileSync(new URL('../domain-migrations/learning/0018_strategy_evidence_metrics_pit_identity.sql', import.meta.url), 'utf8')
    const table = migration.match(/CREATE TABLE strategy_evidence_metrics_v1 \([\s\S]*?\n\);/)?.[0]
    assert(table)
    await db.prepare(table).run()
    const calibration = readFileSync(new URL('../domain-migrations/learning/0026_strategy_evidence_owner_calibration.sql', import.meta.url), 'utf8')
    await db.batch(calibration.split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)))
    const rows = listStrategyEvidenceProfiles(specs).flatMap(profile => profile.required_metrics.map(metric =>
      db.prepare(`INSERT INTO strategy_evidence_metrics_v1(strategy_id,strategy_version,strategy_status,alpha_bucket,
        primary_horizon_days,metric_name,metric_value,metric_status,sample_count,mature_dates,outcome_as_of_date,definition_version)
        VALUES(?,?,?,?,?,?,0.01,'ready',45,12,'2026-09-08','strategy-evidence-metrics-v4')`)
        .bind(profile.strategy_id, profile.strategy_version, profile.strategy_status,
          specs.find(spec => spec.id === profile.strategy_id)!.alphaBucket, profile.primary_horizon_days, metric)))
    await db.batch(rows)
    await run(db)
  } finally { await mf.dispose() }
}

function swapped() {
  return specs.map(spec => spec.id === replacement.candidateId
    ? { ...spec, status: 'active' as const, promotionStatus: 'production' as const }
    : spec.id === replacement.incumbentId ? { ...spec, status: 'candidate' as const, promotionStatus: 'candidate' as const } : spec)
}

for (const boundary of ['producer', 'canonical_reader'] as const) {
  test(`original weight owner mismatch is rejected at ${boundary}, even with valid outer hashes`, async () => fixture(async db => {
    const original = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())
    const productionWeightSource = original.state.evidence.evidence_owner!.weight_source!
    const replay = await replayStrategyWeightSource(productionWeightSource)
    const input = { universe: [], specs, signalDate: '2026-09-10', producerRunId: 'weight-boundary',
      observedAt: '2026-09-10T08:00:00Z', productionWeightSource,
      options: { targetSize: 4, coarseMlQueueSize: 4, strategyWeights: replay.weights.evaluationWeights,
        productionStrategyWeights: replay.weights.routingWeights, performanceWeightOwner: replay.weights.performanceWeightOwner } }
    const valid = await buildLayer1WithAtomicSource(input)
    const identity = { signalDate: input.signalDate, producerRunId: input.producerRunId,
      artifactCreatedAt: '2026-09-10T08:01:00Z', decisionDeadline: '2026-09-10T09:00:00Z' }
    await validateAtomicStrategySource(valid.source, identity)
    for (const fault of ['routing', 'evaluation', 'owner', 'definition']) {
      const changed = structuredClone(input)
      if (fault === 'routing') changed.options.productionStrategyWeights[active.id] *= 2
      if (fault === 'evaluation') changed.options.strategyWeights[active.id] *= 2
      if (fault === 'owner') changed.options.performanceWeightOwner = 'incorrect_owner' as any
      if (fault === 'definition') changed.specs[0].thesis += ' changed'
      if (boundary === 'producer') {
        await assert.rejects(() => buildLayer1WithAtomicSource(changed), /atomic_shadow_original_weight_baseline_mismatch/)
      } else {
        // Reproduce an internally hashed but semantically inconsistent upstream
        // artifact. Hash integrity alone cannot prove original owner parity.
        const { source_checksum: _, ...body } = structuredClone(valid.source)
        body.inputs = changed
        body.baseline_checksum = await atomicNavDigest(buildLayer1StrategyBreadthPlan(changed.universe, changed.specs, changed.options))
        const corrupt = { ...body, source_checksum: await atomicNavDigest(body) }
        await assert.rejects(() => validateAtomicStrategySource(corrupt, identity), /atomic_shadow_original_weight_baseline_mismatch/)
      }
    }
  }))
}

test('publication-day rerun uses old roles AND weights; next decision uses new roles AND weights', async () => fixture(async db => {
  const prior = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const nextDay = new Date(Date.parse(today + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10)
  // Private fixture availability only, not a historical production backfill.
  const priorAvailable = new Date(Date.parse(today + 'T00:00:00+08:00') - 1).toISOString()
  await db.prepare('UPDATE strategy_production_policy_history_v1 SET created_at=? WHERE checksum=?')
    .bind(priorAvailable, prior.checksum).run()
  const next = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(swapped()))
  for (const [day, expected, expectedChecksum] of [[today, specs, prior.checksum], [nextDay, swapped(), next.checksum]] as const) {
    const loaded = await loadStrategyProductionPolicyBefore(db, day, specs.map(spec => spec.id))
    assert(loaded && loaded.checksum === expectedChecksum)
    const serving = await resolveStrategyServingSpecs(swapped(), loaded, day)
    assert.deepEqual(serving, expected)
    const weights = resolveRuntimeStrategyWeights(serving.map(spec => spec.id), loaded)
    const result = await buildLayer1WithAtomicSource({ universe: [], specs: serving,
      signalDate: day, producerRunId: 'policy-role-consumer', observedAt: day + 'T08:00:00Z',
      productionWeightSource: 'evidence_owner' in loaded.state.evidence ? loaded.state.evidence.evidence_owner?.weight_source : undefined,
      options: { targetSize: 4, coarseMlQueueSize: 4, strategyWeights: weights.evaluationWeights,
        productionStrategyWeights: weights.routingWeights, performanceWeightOwner: weights.performanceWeightOwner } })
    assert.deepEqual(result.source.inputs.specs, JSON.parse(JSON.stringify(expected)))
    for (const spec of serving) if (spec.status !== 'active') assert.equal(weights.allocationWeights[spec.id], 0)
    await assert.rejects(() => resolveStrategyServingSpecs(swapped().map(spec => ({ ...spec, thesis: 'changed' })), loaded, day),
      /registry_definition_changed/)
    await assert.rejects(() => resolveStrategyServingSpecs(swapped().map(spec => spec.id === replacement.candidateId
      ? { ...spec, status: 'shadow' } : spec), loaded, day), /role_change_not_replacement/)
  }
  const newPolicy = await loadStrategyProductionPolicyBefore(db, nextDay, specs.map(spec => spec.id))
  await assert.rejects(() => resolveStrategyServingSpecs(swapped(), newPolicy, today), /policy_not_available/)
}))

test('original daily producer preserves complete frozen inputs in its existing immutable policy', async () => fixture(async db => {
  const original = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())
  assert.equal(original.evidenceFusion.profiles.length, 3, 'canonical candidate must keep its own evidence profile')
  assert.equal(original.evidenceFusion.active_profile_count, 2, 'candidate inclusion is not activation')
  assert.equal(original.state.strategy_weights[replacement.candidateId], 0)
  const source = original.state.evidence.evidence_owner?.weight_source
  assert(source)
  const replay = await replayStrategyWeightSource(source)
  assert.deepEqual(replay.weights.allocationWeights, original.state.strategy_weights)
  const loaded = await loadStrategyProductionPolicyBefore(db, '2099-01-01', specs.map(spec => spec.id))
  assert.deepEqual(loaded?.state.evidence.evidence_owner?.weight_source, source)
  assert.equal((await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())).inserted, false)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM strategy_production_policy_history_v1').first<any>())?.n, 1)
}))

test('frozen replacement weights equal a fresh run of the ORIGINAL daily owner with those roles', async () => fixture(async db => {
  const original = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())
  const source = original.state.evidence.evidence_owner!.weight_source!
  const before = JSON.stringify(source)
  const replay = await replayStrategyWeightSource(source, replacement)
  const actual = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(swapped()))
  const runtime = resolveRuntimeStrategyWeights(specs.map(spec => spec.id), {
    state: actual.state, checksum: actual.checksum, created_at: 'fixture' })
  assert.deepEqual(replay.weights, runtime)
  assert.equal(replay.weights.allocationWeights[replacement.candidateId], .5)
  assert.equal(replay.weights.allocationWeights[replacement.incumbentId], 0)
  assert.equal(JSON.stringify(source), before)
}))

test('weight source contains only consumed inputs, never stale lifecycle or threshold advice', async () => fixture(async db => {
  const input = originalPolicyInput()
  const original = await refreshStrategyProductionContributionPolicy(db, input)
  const source = original.state.evidence.evidence_owner!.weight_source!
  assert.equal(source.schema_version, 'strategy-production-weight-source-v2')
  assert.deepEqual(Object.keys(source.inputs.adaptiveState).sort(), ['evidence', 'strategy_weights', 'updated_at'])
  assert.deepEqual(Object.keys(source.inputs.adaptiveState.evidence), ['date'])
  for (const gate of source.inputs.gates) {
    assert.deepEqual(Object.keys(gate).sort(), ['allocation_eligible', 'decision', 'evidence',
      'strategy_id', 'strategy_status', 'strategy_version'])
    assert.deepEqual(Object.keys(gate.evidence).sort(), ['mature_dates', 'samples'])
  }
  const diagnostics = structuredClone(input)
  diagnostics.adaptiveState.lifecycle_recommendations = {}
  diagnostics.adaptiveState.evidence.eligible_strategy_count = 999
  diagnostics.gates[0].missing_evidence = ['unconsumed_diagnostic_only']
  const same = await refreshStrategyProductionContributionPolicy(db, diagnostics)
  assert.equal(same.checksum, original.checksum, 'unused advice cannot create another weight policy')
  assert.equal(same.inserted, false)
  const replay = await replayStrategyWeightSource(source, replacement)
  const daily = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(swapped()))
  assert.equal(daily.evidenceFusion.checksum, '1a8c558e0c9e1f33b53bd6064eccdd5a7a14adc36bf13baf0cf8c09065465d1f',
    'golden original v3 daily owner checksum must not change due to JSON transport')
  assert.deepEqual(replay.inputs, daily.state.evidence.evidence_owner!.weight_source!.inputs,
    'post-replacement capsule must match the fresh daily owner, not just the final weights')
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value
  const oldBody = { schema_version: 'strategy-production-weight-source-v1' as const,
    kernel_version: source.kernel_version, baseline_policy_checksum: source.baseline_policy_checksum,
    inputs: { ...input, evidenceFusion: original.evidenceFusion } }
  const old = { ...oldBody, source_checksum: await sha256StrategyProductionPolicyPayload(JSON.stringify(sorted(oldBody))) }
  const oldBytes = JSON.stringify(old)
  const continued = await replayStrategyWeightSource(old, replacement)
  assert.deepEqual(continued.inputs, replay.inputs)
  assert.deepEqual(continued.weights, replay.weights)
  assert.equal(JSON.stringify(old), oldBytes, 'immutable v1 evidence is not rewritten or relabelled')
  const changed = structuredClone(old)
  changed.baseline_policy_checksum = 'f'.repeat(64)
  const { source_checksum: _, ...changedBody } = changed
  changed.source_checksum = await sha256StrategyProductionPolicyPayload(JSON.stringify(sorted(changedBody)))
  await assert.rejects(() => replayStrategyWeightSource(changed), /baseline_changed/)
  console.log('NAV_WEIGHT_SOURCE_BYTES=' + JSON.stringify({
    original_inputs: Buffer.byteLength(JSON.stringify({ ...input, evidenceFusion: original.evidenceFusion })),
    consumed_inputs: Buffer.byteLength(JSON.stringify(source.inputs)),
  }))
}))

test('unready candidate stays zero without transferring the predecessor evidence or weight', async () => fixture(async db => {
  const original = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(specs, 29))
  const replay = await replayStrategyWeightSource(original.state.evidence.evidence_owner!.weight_source!, replacement)
  const actual = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(swapped(), 29))
  assert.deepEqual(replay.weights.allocationWeights, actual.state.strategy_weights)
  assert.equal(replay.weights.allocationWeights[replacement.candidateId], 0)
  assert.equal(replay.weights.allocationWeights[specs[2].id], 1)
  assert.equal(replay.inputs.gates.find(g => g.strategy_id === replacement.candidateId)?.evidence.samples, 29)
}))

test('the next daily source uses new observations while the frozen old source remains unchanged', async () => fixture(async db => {
  const old = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(specs, 29))
  const source = old.state.evidence.evidence_owner!.weight_source!
  const next = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(specs, 45, '2026-09-10'))
  const nextSource = next.state.evidence.evidence_owner!.weight_source!
  assert.notEqual(source.source_checksum, nextSource.source_checksum)
  assert.equal((await replayStrategyWeightSource(source, replacement)).weights.allocationWeights[replacement.candidateId], 0)
  const atomic = async (saved: typeof source) => {
    const baseline = await replayStrategyWeightSource(saved)
    return buildAtomicStrategyShadow({ universe: [], expectedUniverseSymbols: [], specs, replacement,
      productionWeightSource: saved, options: { targetSize: 10, coarseMlQueueSize: 10,
        strategyWeights: baseline.weights.evaluationWeights, productionStrategyWeights: baseline.weights.routingWeights,
        performanceWeightOwner: baseline.weights.performanceWeightOwner } })
  }
  const firstAtomic = await atomic(source), nextAtomic = await atomic(nextSource)
  assert.equal(firstAtomic.replacement_definition_checksum, nextAtomic.replacement_definition_checksum,
    'daily readiness/weights are observations, not a new candidate or maturity reset')
  assert.notEqual(firstAtomic.runtime_context_checksum, nextAtomic.runtime_context_checksum)
  assert.equal(firstAtomic.candidate_policy.options.productionStrategyWeights[replacement.candidateId], 0)
  assert.equal(nextAtomic.candidate_policy.options.productionStrategyWeights[replacement.candidateId], 1)
  assert.equal((await replayStrategyWeightSource(nextSource, replacement)).weights.allocationWeights[replacement.candidateId], .5)
  assert.equal((await replayStrategyWeightSource(source, replacement)).weights.allocationWeights[replacement.candidateId], 0)
}))

test('source tampering, mixed dates and non-original adaptive weights cannot become an executable replay', async () => fixture(async db => {
  const original = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())
  const source = original.state.evidence.evidence_owner!.weight_source!
  const tampered = structuredClone(source)
  tampered.inputs.adaptiveState.strategy_weights[replacement.candidateId] = 1
  await assert.rejects(() => replayStrategyWeightSource(tampered), /integrity_failed/)
  const mixed = structuredClone(source.inputs)
  mixed.adaptiveState.evidence.date = '2026-09-10'
  await assert.rejects(() => captureStrategyWeightSource(mixed, original.state), /cutoff_mismatch/)
  const weights = structuredClone(source.inputs)
  weights.adaptiveState.strategy_weights[active.id] = .9
  await assert.rejects(() => captureStrategyWeightSource(weights, original.state), /adaptive_owner_mismatch/)
  await assert.rejects(() => replayStrategyWeightSource(source, { ...replacement, candidateVersion: 'wrong' }), /replacement_changed/)
}))

test('same-day evidence is not borrowed to make a missing candidate profile ready', async () => fixture(async db => {
  await db.prepare("UPDATE strategy_evidence_metrics_v1 SET outcome_as_of_date='2026-09-09' WHERE strategy_id=?")
    .bind(replacement.candidateId).run()
  const original = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())
  assert.equal(original.evidenceFusion.integration_ready, true, 'active population is unaffected')
  const profile = original.evidenceFusion.profiles.find(p => p.strategy_id === replacement.candidateId)!
  assert.equal(profile.integration_status, 'missing')
  await assert.rejects(() => replayStrategyWeightSource(original.state.evidence.evidence_owner!.weight_source!, replacement),
    /strategy_evidence_owner_integration_not_ready/)
}))

test('non-neutral original calibration survives capture and role substitution without predecessor inheritance', async () => fixture(async db => {
  const dates = ['2026-08-26','2026-08-27','2026-08-28','2026-08-31','2026-09-01',
    '2026-09-02','2026-09-03','2026-09-04','2026-09-07','2026-09-08']
  const profiles = listStrategyEvidenceProfiles(specs).map(profile => ({ ...profile, strategy_status: 'active' }))
    .sort((a, b) => a.strategy_id.localeCompare(b.strategy_id))
  // Synthetic historical calibration had all three strategies active. Current
  // candidate role must not erase its OWN existing coefficient or borrow another.
  const quality = (id: string) => id === active.id ? .03 : id === replacement.candidateId ? 0 : -.03
  const metricRows = dates.flatMap(date => profiles.flatMap(profile => profile.required_metrics.map(metric => ({
    strategy_id: profile.strategy_id, strategy_version: profile.strategy_version,
    primary_horizon_days: profile.primary_horizon_days, metric_name: metric,
    metric_value: quality(profile.strategy_id), metric_status: 'ready',
    outcome_as_of_date: date, definition_version: 'strategy-evidence-metrics-v4',
  }))))
  const result = await evaluateStrategyEvidenceOwnerCalibration({ profiles, metricRows,
    dateReturns: dates.slice(1).flatMap(date => profiles.map(profile => ({
      strategy_id: profile.strategy_id, strategy_version: profile.strategy_version,
      signal_date: date, residual_return_net: quality(profile.strategy_id), sample_count: 100,
    }))), allowPromotion: true })
  assert.equal(result.status, 'promoted', JSON.stringify(result.gates))
  await db.batch(specs.map(spec => db.prepare('UPDATE strategy_evidence_metrics_v1 SET metric_value=? WHERE strategy_id=?')
    .bind(quality(spec.id), spec.id)))
  const run = { run_id: 'synthetic-original-calibration', artifact_version: STRATEGY_EVIDENCE_OWNER_CALIBRATION_VERSION,
    knowledge_cutoff_date: cutoff, status: result.status, source_metric_definition_version: 'strategy-evidence-metrics-v4',
    source_snapshot_count: result.sourceSnapshotCount, source_snapshot_checksum: result.sourceSnapshotChecksum,
    sample_count: result.sampleCount, date_count: result.dateCount,
    train_dates_json: JSON.stringify(result.trainDates), purge_dates_json: JSON.stringify(result.purgeDates),
    oos_dates_json: JSON.stringify(result.oosDates), baseline_return: result.baselineReturn,
    challenger_return: result.challengerReturn, challenger_delta: result.challengerDelta,
    challenger_delta_lcb90: result.challengerDeltaLcb90, coverage: result.coverage,
    gate_json: JSON.stringify({ ...result.gates, history_checksum: result.historyChecksum }),
    artifact_checksum: result.artifactChecksum }
  const columns = Object.keys(run)
  await db.prepare(`INSERT INTO strategy_evidence_owner_calibration_runs_v1 (${columns.join(',')})
    VALUES(${columns.map(() => '?').join(',')})`).bind(...Object.values(run)).run()
  await db.batch(result.artifacts.map(artifact => db.prepare(`INSERT INTO strategy_evidence_owner_calibration_artifacts_v1
    (artifact_id,run_id,strategy_id,strategy_version,metric_outcome_as_of_date,multi_horizon_score,
     weight_multiplier,source_metric_checksum,payload_checksum) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind('fixture:' + artifact.strategy_id, run.run_id, artifact.strategy_id, artifact.strategy_version,
      artifact.metric_outcome_as_of_date, artifact.multi_horizon_score, artifact.weight_multiplier,
      artifact.source_metric_checksum, artifact.payload_checksum)))
  const original = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput())
  assert.equal(original.evidenceFusion.weight_effect, 'immutable_oos_calibrated_bounded_bidirectional')
  const source = original.state.evidence.evidence_owner!.weight_source!
  const replay = await replayStrategyWeightSource(source, replacement)
  const actual = await refreshStrategyProductionContributionPolicy(db, originalPolicyInput(swapped()))
  assert.deepEqual(replay.weights.allocationWeights, actual.state.strategy_weights)
  const own = original.evidenceFusion.profiles.find(p => p.strategy_id === replacement.candidateId)!
  const predecessor = original.evidenceFusion.profiles.find(p => p.strategy_id === replacement.incumbentId)!
  assert.notEqual(own.weight_multiplier, predecessor.weight_multiplier)
  assert.equal(replay.inputs.evidenceFusion.profiles.find(p => p.strategy_id === replacement.candidateId)?.weight_multiplier,
    own.weight_multiplier)
  assert.notEqual(replay.weights.allocationWeights[replacement.candidateId], .5)
  const baselineWeights = resolveRuntimeStrategyWeights(specs.map(spec => spec.id), {
    state: original.state, checksum: original.checksum, created_at: 'fixture' })
  const atomicInput = { universe: [], expectedUniverseSymbols: [], specs, replacement,
    options: { targetSize: 10, coarseMlQueueSize: 10,
      strategyWeights: baselineWeights.evaluationWeights, productionStrategyWeights: baselineWeights.routingWeights,
      performanceWeightOwner: baselineWeights.performanceWeightOwner } }
  const legacy = await buildAtomicStrategyShadow(atomicInput)
  const corrected = await buildAtomicStrategyShadow({ ...atomicInput, productionWeightSource: source })
  assert.deepEqual(corrected.candidate_policy.options.productionStrategyWeights, replay.weights.routingWeights)
  assert.notDeepEqual(legacy.candidate_policy.options.productionStrategyWeights, replay.weights.routingWeights)
  assert.notEqual(corrected.replacement_definition_checksum, legacy.replacement_definition_checksum)
  assert.equal(corrected.weight_policy_version, source.kernel_version)
  const oldContinuation = await buildAtomicStrategyShadow({ ...atomicInput, productionWeightSource: source,
    continuationDefinitionChecksum: legacy.replacement_definition_checksum })
  assert.equal(oldContinuation.weight_policy_version, undefined)
  assert.equal(oldContinuation.replacement_definition_checksum, legacy.replacement_definition_checksum)
  assert.deepEqual(oldContinuation.candidate_policy.options.productionStrategyWeights,
    legacy.candidate_policy.options.productionStrategyWeights)
  console.log('NAV_ORIGINAL_WEIGHT_REPLAY=' + JSON.stringify({ scope: 'synthetic_software_parity_not_roi',
    candidate_own_multiplier: own.weight_multiplier, predecessor_multiplier: predecessor.weight_multiplier,
    legacy_transfer_route_weight: legacy.candidate_policy.options.productionStrategyWeights[replacement.candidateId],
    corrected_route_weight: corrected.candidate_policy.options.productionStrategyWeights[replacement.candidateId],
    replay_allocation_weight: replay.weights.allocationWeights[replacement.candidateId],
    original_daily_allocation_weight: actual.state.strategy_weights[replacement.candidateId] }))
}))
