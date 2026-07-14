import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Bindings } from '../types'
import { StrategyDiscoveryArtifacts } from './artifacts'
import { runCheckpoint } from './checkpoints'
import { canReserveAnalysis, isLocalFixtureModeAuthorized, MODEL_REGISTRY, STRATEGY_DISCOVERY_SCHEMA_VERSION, type ModelRole } from './config'
import { UNKNOWN, type RegimeSampleEvidence, type SharedSystemProfile, type SnapshotManifest, type StrategyCandidate, type StrategyHypothesis } from './domain'
import { fixtureCandidates, fixtureFeatureMap, fixtureHypotheses } from './fixtures'
import { loadFeatureRegistrySnapshot } from './featureRegistry'
import { hashJson } from './hashing'
import { buildDeterministicFeatureIntelligence, buildPortfolioGapMap } from './intelligence'
import { applyCrossExamination, normalizeAndMergeIssues } from './issues'
import { buildJuryBundle } from './juryBundle'
import { MODEL_OUTPUT_SCHEMAS, validateAvailability, validateFeatureMap, validatePrivacyCrossExamination, validatePrivacyIssueBatch, validatePrivacyShortlist, validateSingleDsl, validateSingleHypothesis } from './modelContracts'
import { assertPrivacySafePayload, buildPrivacyCrossExaminationBatches, buildPrivacyRedTeamPayload, buildPrivacyShortlistPayload, materializePrivacyCrossExamination, materializePrivacyIssues, materializePrivacyShortlist, privacyFixtureCrossExamination, privacyFixtureIssueBatch, privacyFixtureShortlist, type PrivacyRole } from './privacyProjection'
import { StrategyDiscoveryRepository } from './repositories'
import { roleMessages } from './rolePrompts'
import { buildStrategyRegistrySnapshot } from './strategyRegistry'
import { staticValidateCandidates, validateHypothesisAllocation } from './staticValidation'
import { StrategyDiscoveryWorkersAiClient } from './workersAiClient'

interface WorkflowParams { run_id: string; attempt: number }
const BLOCKED = 'STRATEGY_DISCOVERY_BLOCKED:'

function day(value = new Date()): string { return value.toISOString().slice(0, 10) }
function asError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function blocked(message: string): never { throw new Error(`${BLOCKED}${message}`) }
async function modelAvailability(client: StrategyDiscoveryWorkersAiClient, env: Bindings, runId: string) {
  const representatives: ModelRole[] = ['FEATURE_LIBRARIAN', 'HYPOTHESIS_SCIENTIST', 'PORTFOLIO_JUDGE']
  const results: Array<{ source_type: 'REAL' | 'FIXTURE'; cached?: boolean }> = []
  // Probe sequentially to avoid five simultaneous remote cold starts. Actual
  // discovery and red-team inference remain parallel in their required steps.
  for (const role of representatives) {
    const model = MODEL_REGISTRY[role].model
    const cacheKey = `strategy-discovery:model-availability:${model}`
    const cached = await env.KV.get(cacheKey, 'json').catch(() => null) as { ok?: boolean } | null
    if (cached?.ok === true) { results.push({ source_type: 'REAL', cached: true }); continue }
    try {
      const result = await client.invoke({ runId, stepId: '01_preflight', role,
        messages: [{ role: 'system', content: 'Availability probe. Return {"ok":"OK"} only.' }, { role: 'user', content: 'Return OK.' }],
        outputSchema: MODEL_OUTPUT_SCHEMAS.availability, validate: validateAvailability, fixture: { ok: 'OK' }, maxTokens: 512 })
      await env.KV.put(cacheKey, JSON.stringify({ ok: true, checked_at: new Date().toISOString() }), { expirationTtl: 3600 })
      results.push(result)
    } catch (error) {
      await env.KV.put(cacheKey, JSON.stringify({ ok: false, checked_at: new Date().toISOString(), error: asError(error).slice(0, 300) }), { expirationTtl: 900 }).catch(() => undefined)
      throw error
    }
  }
  return {
    ...Object.fromEntries(representatives.map((role, index) => [MODEL_REGISTRY[role].model, { ok: true, source_type: results[index].source_type }])),
    [MODEL_REGISTRY.REGIME_EXPLORER.model]: { ok: 'DEFERRED_TO_REQUIRED_ROLE_CALL', role: 'REGIME_EXPLORER' },
    [MODEL_REGISTRY.EXECUTION_ARCHITECT.model]: { ok: 'DEFERRED_TO_REQUIRED_ROLE_CALL', role: 'EXECUTION_ARCHITECT', fallback: MODEL_REGISTRY.EXECUTION_ARCHITECT.fallback?.model },
  }
}

async function executeStep<T>(input: {
  env: Bindings; workflowStep: WorkflowStep; runId: string; workflowAttempt: number; index: number; stepId: string; stepInput: unknown; modelRole?: ModelRole; compute: () => Promise<T>
}): Promise<T> {
  const repository = new StrategyDiscoveryRepository(input.env.DB)
  const artifacts = new StrategyDiscoveryArtifacts(input.env.ARTIFACTS, repository)
  const inputHash = await hashJson(input.stepInput)
  await repository.updateRun(input.runId, { status: 'RUNNING', currentStep: input.stepId, heartbeat: true })
  return input.workflowStep.do(input.stepId, { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '15 minutes' }, async () => {
    await repository.startWorkflowStep({ runId: input.runId, stepId: input.stepId, attempt: input.workflowAttempt, inputHash, modelRole: input.modelRole })
    try {
      const result = await runCheckpoint({ runId: input.runId, stepId: input.stepId, stepInput: input.stepInput, repository, artifacts, compute: input.compute })
      await repository.finishWorkflowStep({ runId: input.runId, stepId: input.stepId, attempt: input.workflowAttempt, status: result.reused ? 'SKIPPED_REUSED' : 'COMPLETED', outputHash: result.outputHash })
      await repository.updateRun(input.runId, { completedSteps: input.index, currentStep: input.stepId, heartbeat: true })
      return result.value
    } catch (error) {
      await repository.finishWorkflowStep({ runId: input.runId, stepId: input.stepId, attempt: input.workflowAttempt, status: 'FAILED', errorCode: asError(error).slice(0, 120), errorDetail: asError(error).slice(0, 2_000) }).catch(() => undefined)
      throw error
    }
  })
}

export class StrategyDiscoveryWorkflow extends WorkflowEntrypoint<Bindings, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, workflowStep: WorkflowStep): Promise<unknown> {
    const { run_id: runId, attempt } = event.payload
    const repository = new StrategyDiscoveryRepository(this.env.DB)
    const artifacts = new StrategyDiscoveryArtifacts(this.env.ARTIFACTS, repository)
    const run = await repository.getRun(runId)
    if (!run) throw new Error('strategy_discovery_run_missing')
    const fixtureMode = run.fixture_mode
    if (fixtureMode && !isLocalFixtureModeAuthorized(this.env)) blocked('fixture_mode_not_authorized')

    try {
      const strategySnapshot = await buildStrategyRegistrySnapshot(await repository.activeStrategyRows())
      const featureSnapshot = await loadFeatureRegistrySnapshot(strategySnapshot.featureUsage)
      const regimeEvidence = await repository.regimeSampleEvidence()
      const systemProfile: SharedSystemProfile & { regime_contract: string; regime_sample_evidence: RegimeSampleEvidence[] } = {
        schema_version: STRATEGY_DISCOVERY_SCHEMA_VERSION, market: 'TW_EQUITY', timezone: 'Asia/Taipei',
        feature_availability_policy: 'UNKNOWN timing requires positive lag; T_CLOSE signal executes no earlier than T_PLUS_1_OPEN',
        strategy_execution_policy: 'research-only; no promotion, deployment, retrain, scheduler mutation, broker, or order path',
        transaction_cost_policy: 'UNKNOWN', data_sources: ['formal137 feature registry', 'D1 strategy_spec_registry', 'D1 strategy_reward_ledger'],
        source_hashes: { feature_registry: featureSnapshot.sourceHash, strategy_registry: strategySnapshot.snapshotHash, regime_evidence: await hashJson(regimeEvidence) },
        regime_contract: 'worker/src/lib/marketRegimeState.ts: bull|bear|volatile|sideways point-in-time KV state', regime_sample_evidence: regimeEvidence,
      }
      const systemProfileHash = await hashJson(systemProfile)
      const inputHash = await hashJson({ feature: featureSnapshot.snapshotHash, strategy: strategySnapshot.snapshotHash, system: systemProfileHash })

      const preflight = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 1, stepId: '01_preflight',
        stepInput: { inputHash, fixtureMode, prompt: run.prompt_set_version, schema: run.schema_set_version }, compute: async () => {
          if (!this.env.ARTIFACTS) blocked('r2_binding_missing')
          if (!fixtureMode && !this.env.AI) blocked('workers_ai_binding_missing')
          const knownUsed = await repository.knownUsedNeurons(day())
          const reservationRaw = await this.env.KV.get(`strategy-discovery:external-neurons:${day()}`, 'text').catch(() => null) ?? this.env.STRATEGY_DISCOVERY_EXTERNAL_RESERVED_NEURONS
          if (this.env.STRATEGY_DISCOVERY_REQUIRE_EXTERNAL_USAGE_RESERVATION === '1' && !reservationRaw) blocked('external_neuron_reservation_missing')
          const externalReserved = Math.max(0, Number(reservationRaw ?? 0) || 0)
          if (!canReserveAnalysis(knownUsed, externalReserved)) blocked('workers_ai_safe_budget_insufficient')
          if (featureSnapshot.cards.length !== 137) blocked(`feature_count:${featureSnapshot.cards.length}`)
          if (strategySnapshot.cards.length !== 13) blocked(`strategy_count:${strategySnapshot.cards.length}`)
          if (regimeEvidence.filter((row) => row.max_samples > 0).length < 2) blocked('mode_d_regime_sample_evidence_insufficient')
          const client = new StrategyDiscoveryWorkersAiClient(this.env.AI, repository, artifacts, fixtureMode)
          let availability
          try { availability = await modelAvailability(client, this.env, runId) } catch (error) { blocked(`required_model_unavailable:${asError(error)}`) }
          return { featureSnapshot, strategySnapshot, regimeEvidence, systemProfile, systemProfileHash, inputHash, availability }
        } })

      const frozen = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 2, stepId: '02_freeze_snapshot', stepInput: { inputHash: preflight.inputHash }, compute: async () => {
        const createdAt = new Date().toISOString()
        const manifest: SnapshotManifest = { schema_version: STRATEGY_DISCOVERY_SCHEMA_VERSION, run_id: runId, created_at: createdAt,
          feature_version: preflight.featureSnapshot.featureVersion, strategy_version: preflight.strategySnapshot.strategyVersion,
          feature_snapshot_hash: preflight.featureSnapshot.snapshotHash, strategy_snapshot_hash: preflight.strategySnapshot.snapshotHash,
          system_profile_hash: preflight.systemProfileHash, input_hash: preflight.inputHash, feature_count: preflight.featureSnapshot.cards.length,
          strategy_count: preflight.strategySnapshot.cards.length, fixture_mode: fixtureMode }
        const featureArtifact = await artifacts.putJson(runId, 'feature-registry', preflight.featureSnapshot.cards)
        const strategyArtifact = await artifacts.putJson(runId, 'existing-strategies', preflight.strategySnapshot.cards)
        const systemArtifact = await artifacts.putJson(runId, 'shared-system-profile', preflight.systemProfile)
        const manifestArtifact = await artifacts.putJson(runId, 'run-manifest', manifest)
        await repository.saveFeatureVersion({ featureVersion: preflight.featureSnapshot.featureVersion, sourcePath: preflight.featureSnapshot.sourcePath, sourceHash: preflight.featureSnapshot.sourceHash, snapshotHash: preflight.featureSnapshot.snapshotHash, cards: preflight.featureSnapshot.cards })
        await repository.saveStrategyVersion({ strategyVersion: preflight.strategySnapshot.strategyVersion, source: preflight.strategySnapshot.source, snapshotHash: preflight.strategySnapshot.snapshotHash, cards: preflight.strategySnapshot.cards, cardHashes: preflight.strategySnapshot.cardHashes })
        await Promise.all([
          repository.saveSnapshot(manifest, 'FEATURES', manifest.feature_version, manifest.feature_snapshot_hash, featureArtifact.key, manifest.feature_count),
          repository.saveSnapshot(manifest, 'STRATEGIES', manifest.strategy_version, manifest.strategy_snapshot_hash, strategyArtifact.key, manifest.strategy_count),
          repository.saveSnapshot(manifest, 'SYSTEM_PROFILE', STRATEGY_DISCOVERY_SCHEMA_VERSION, manifest.system_profile_hash, systemArtifact.key, 1),
          repository.saveSnapshot(manifest, 'RUN_MANIFEST', STRATEGY_DISCOVERY_SCHEMA_VERSION, preflight.inputHash, manifestArtifact.key, 1),
        ])
        await repository.updateRun(runId, { featureVersion: manifest.feature_version, strategyVersion: manifest.strategy_version,
          featureSnapshotHash: manifest.feature_snapshot_hash, strategySnapshotHash: manifest.strategy_snapshot_hash,
          systemProfileHash: manifest.system_profile_hash, inputHash: manifest.input_hash })
        return { manifest, features: preflight.featureSnapshot.cards, strategies: preflight.strategySnapshot.cards, regimeEvidence: preflight.regimeEvidence, systemProfile: preflight.systemProfile }
      } })

      const featureIntelligence = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 3, stepId: '03_feature_intelligence', modelRole: 'FEATURE_LIBRARIAN', stepInput: { inputHash: frozen.manifest.input_hash }, compute: async () => {
        const deterministic = buildDeterministicFeatureIntelligence(frozen.features, frozen.strategies)
        await repository.saveFeatureClusters(runId, deterministic.feature_clusters, 'deterministic:source_cluster_or_family_fallback')
        const messages = roleMessages('FEATURE_LIBRARIAN', {
          cluster_statistics: deterministic.feature_clusters.map((row) => ({
            cluster_id: row.cluster_id,
            family: row.family,
            feature_count: row.feature_count,
            used_feature_count: row.used_feature_count,
            strategy_count: row.strategy_ids.length,
            method: row.method,
          })),
          family_distribution: deterministic.family_distribution,
          exact_strategy_feature_duplicate_groups: deterministic.exact_feature_duplicate_groups,
          limitations: deterministic.limitations,
          instruction: 'Return at most 6 concise observations. Empty arrays are required when duplicate feature IDs or coverage gaps are not proven by the supplied statistics.',
        })
        const call = await new StrategyDiscoveryWorkersAiClient(this.env.AI, repository, artifacts, fixtureMode).invoke({ runId, stepId: '03_feature_intelligence', role: 'FEATURE_LIBRARIAN', messages, outputSchema: MODEL_OUTPUT_SCHEMAS.feature_map, validate: validateFeatureMap, fixture: fixtureFeatureMap(deterministic) })
        return { deterministic, feature_map: call.parsed, raw: call.raw, prompt: messages }
      } })

      const gaps = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 4, stepId: '04_portfolio_gap_map', stepInput: { intelligence: await hashJson(featureIntelligence.deterministic) }, compute: async () => {
        const gap_map = buildPortfolioGapMap(frozen.features, frozen.strategies, featureIntelligence.deterministic)
        const stored = await artifacts.putJson(runId, 'portfolio-gap-map', gap_map)
        await repository.saveGapMap(runId, gap_map, stored.hash, stored.key)
        return { gap_map }
      } })

      const hypothesisOutput = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 5, stepId: '05_hypothesis_generation', stepInput: { gap: await hashJson(gaps.gap_map), regime: await hashJson(frozen.regimeEvidence) }, compute: async () => {
        const fixtures = fixtureHypotheses({ runId, features: frozen.features, strategies: frozen.strategies, gaps: gaps.gap_map, regimes: frozen.regimeEvidence })
        const regimeFeatureIds = featureIntelligence.deterministic.feature_clusters
          .filter((row) => gaps.gap_map.unused_feature_clusters.includes(row.cluster_id))
          .flatMap((row) => row.feature_ids).slice(0, 40)
        const boundedFeatureIds = regimeFeatureIds.length ? regimeFeatureIds : frozen.features.slice(0, 40).map((row) => row.feature_id)
        const clusterByFeature = new Map(featureIntelligence.deterministic.feature_clusters.flatMap((cluster) => cluster.feature_ids.map((featureId) => [featureId, cluster.cluster_id] as const)))
        const featureOptions = boundedFeatureIds.map((featureId) => ({ feature_id: featureId, cluster_id: clusterByFeature.get(featureId) ?? UNKNOWN }))
        const strategyOptions = frozen.strategies.map((row) => ({ strategy_id: row.strategy_id, feature_ids: row.feature_ids, preferred_regimes: row.preferred_regimes }))
        const client = new StrategyDiscoveryWorkersAiClient(this.env.AI, repository, artifacts, fixtureMode)
        const singleFixture = (row: StrategyHypothesis) => ({ hypothesis: row.hypothesis, economic_mechanism: row.economic_mechanism,
          portfolio_gap: row.portfolio_gap, preferred_regimes: row.preferred_regimes, falsification_condition: row.falsification_condition })
        const regimeAssignments = [...frozen.regimeEvidence].filter((row) => row.max_samples > 0).sort((a, b) => b.max_samples - a.max_samples).slice(0, 2)
        if (regimeAssignments.length < 2) throw new Error('regime_assignments_insufficient')
        const regimeResults: Array<{ parsed: any; raw: unknown; prompt: unknown; featureId: string; regime: RegimeSampleEvidence['regime']; modelId: string }> = []
        for (let index = 0; index < 2; index += 1) {
          const assigned = regimeAssignments[index]
          const featureId = boundedFeatureIds[index % boundedFeatureIds.length]
          const messages = roleMessages('REGIME_EXPLORER', { regime_contract: frozen.systemProfile.regime_contract, assigned_regime: assigned,
            assigned_feature_id: featureId, gap_map: gaps.gap_map,
            instruction: 'Produce one Mode D hypothesis for exactly the assigned point-in-time regime and canonical feature. The Worker assigns structural metadata and sample normalization.' })
          const call = await client.invoke({ runId, stepId: '05_hypothesis_generation', role: 'REGIME_EXPLORER', messages,
            outputSchema: MODEL_OUTPUT_SCHEMAS.single_hypothesis, validate: validateSingleHypothesis, fixture: singleFixture(fixtures.gemma.hypotheses[index]) })
          regimeResults.push({ parsed: call.parsed, raw: call.raw, prompt: messages, featureId, regime: assigned.regime, modelId: call.model_id })
        }
        const cFixtures = fixtures.mistral.hypotheses.filter((row) => row.search_mode === 'MODE_C_PORTFOLIO_GAP')
        const bFixtures = fixtures.mistral.hypotheses.filter((row) => row.search_mode === 'MODE_B_PARENT_MUTATION')
        const modeCResults: Array<{ parsed: any; raw: unknown; prompt: unknown; featureId: string; modelId: string }> = []
        for (let index = 0; index < 6; index += 1) {
          const featureId = featureOptions[index % featureOptions.length].feature_id
          const messages = roleMessages('HYPOTHESIS_SCIENTIST', { gap_map: gaps.gap_map, assigned_feature_id: featureId,
            instruction: 'Produce one Mode C portfolio-gap hypothesis using the assigned canonical feature. The Worker assigns structural metadata.' })
          const call = await client.invoke({ runId, stepId: '05_hypothesis_generation', role: 'HYPOTHESIS_SCIENTIST', messages,
            outputSchema: MODEL_OUTPUT_SCHEMAS.single_hypothesis, validate: validateSingleHypothesis, fixture: singleFixture(cFixtures[index]) })
          modeCResults.push({ parsed: call.parsed, raw: call.raw, prompt: messages, featureId, modelId: call.model_id })
        }
        const mutationTypes = ['ADD_GATE', 'REPLACE_FEATURE', 'SIMPLIFY_RULE', 'REDUCE_TURNOVER'] as const
        const modeBResults: Array<{ parsed: any; raw: unknown; prompt: unknown; featureId: string; parentId: string; mutationType: typeof mutationTypes[number]; modelId: string }> = []
        for (let index = 0; index < 4; index += 1) {
          const featureId = featureOptions[(index + 6) % featureOptions.length].feature_id
          const parentId = strategyOptions[index % strategyOptions.length].strategy_id
          const mutationType = mutationTypes[index]
          const messages = roleMessages('HYPOTHESIS_SCIENTIST', { gap_map: gaps.gap_map, assigned_parent_strategy_id: parentId,
            assigned_mutation_type: mutationType, assigned_feature_id: featureId,
            instruction: 'Produce one Mode B parent-mutation hypothesis for exactly the assigned parent, mutation, and canonical feature. The Worker assigns structural metadata.' })
          const call = await client.invoke({ runId, stepId: '05_hypothesis_generation', role: 'HYPOTHESIS_SCIENTIST', messages,
            outputSchema: MODEL_OUTPUT_SCHEMAS.single_hypothesis, validate: validateSingleHypothesis, fixture: singleFixture(bFixtures[index]) })
          modeBResults.push({ parsed: call.parsed, raw: call.raw, prompt: messages, featureId, parentId, mutationType, modelId: call.model_id })
        }
        const evidence = new Map(frozen.regimeEvidence.map((row) => [row.regime, row.max_samples]))
        const normalize = (rows: StrategyHypothesis[], role: 'HYPOTHESIS_SCIENTIST' | 'REGIME_EXPLORER') => rows.map((row, index) => ({ ...row,
          hypothesis_id: `${role === 'HYPOTHESIS_SCIENTIST' ? 'HS' : 'RE'}-${String(index + 1).padStart(2, '0')}`,
          run_id: runId,
          minimum_regime_samples: row.search_mode === 'MODE_D_REGIME_SPECIALIST' ? (evidence.get(row.preferred_regimes[0] as RegimeSampleEvidence['regime']) ?? UNKNOWN) : UNKNOWN,
          source_model: row.source_model || MODEL_REGISTRY[role].model, source_type: fixtureMode ? 'FIXTURE' as const : 'REAL' as const }))
        const regimeSuggestions = regimeResults.map((row) => ({
          search_mode: 'MODE_D_REGIME_SPECIALIST' as const, parent_strategy_id: null, mutation_type: null,
          hypothesis: row.parsed.hypothesis, economic_mechanism: row.parsed.economic_mechanism, portfolio_gap: row.parsed.portfolio_gap,
          preferred_regimes: [row.regime], feature_ids: [row.featureId], falsification_condition: row.parsed.falsification_condition, source_model: row.modelId,
        })) as StrategyHypothesis[]
        const modeCSuggestions = modeCResults.map((row) => ({ ...row.parsed, search_mode: 'MODE_C_PORTFOLIO_GAP', parent_strategy_id: null, mutation_type: null, feature_ids: [row.featureId], source_model: row.modelId })) as StrategyHypothesis[]
        const modeBSuggestions = modeBResults.map((row) => ({ ...row.parsed, search_mode: 'MODE_B_PARENT_MUTATION', parent_strategy_id: row.parentId, mutation_type: row.mutationType, feature_ids: [row.featureId], source_model: row.modelId })) as StrategyHypothesis[]
        const hypotheses = [...normalize([...modeCSuggestions, ...modeBSuggestions], 'HYPOTHESIS_SCIENTIST'), ...normalize(regimeSuggestions, 'REGIME_EXPLORER')]
        const errors = validateHypothesisAllocation(hypotheses)
        if (errors.length) throw new Error(`hypothesis_policy_validation_failed:${errors.join(',')}`)
        const hashes = Object.fromEntries(await Promise.all(hypotheses.map(async (row) => [row.hypothesis_id, await hashJson(row)])))
        await repository.saveHypotheses(hypotheses, hashes)
        return { hypotheses, raw: { HYPOTHESIS_SCIENTIST: { MODE_C: modeCResults.map((row) => row.raw), MODE_B: modeBResults.map((row) => row.raw) }, REGIME_EXPLORER: regimeResults.map((row) => row.raw) },
          prompts: { HYPOTHESIS_SCIENTIST: { MODE_C: modeCResults.map((row) => row.prompt), MODE_B: modeBResults.map((row) => row.prompt) }, REGIME_EXPLORER: regimeResults.map((row) => row.prompt) } }
      } })

      const candidateOutput = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 6, stepId: '06_strategy_dsl', modelRole: 'EXECUTION_ARCHITECT', stepInput: { hypotheses: await hashJson(hypothesisOutput.hypotheses) }, compute: async () => {
        const fixtureRows = fixtureCandidates(runId, hypothesisOutput.hypotheses).candidates
        const client = new StrategyDiscoveryWorkersAiClient(this.env.AI, repository, artifacts, fixtureMode)
        const results: Array<{ candidate: StrategyCandidate; raw: unknown; prompt: unknown }> = []
        const batchSize = 3
        for (let offset = 0; offset < hypothesisOutput.hypotheses.length; offset += batchSize) {
          const batch = await Promise.all(hypothesisOutput.hypotheses.slice(offset, offset + batchSize).map(async (hypothesis, batchIndex) => {
            const index = offset + batchIndex
            const allowed = new Set(hypothesis.feature_ids)
            const timing = frozen.features.filter((row) => allowed.has(row.feature_id)).map((row) => ({ feature_id: row.feature_id, availability_lag: row.availability_lag, earliest_execution: row.earliest_execution }))
            const messages = roleMessages('EXECUTION_ARCHITECT', { hypothesis, feature_timing: timing,
              instruction: 'Return one executable bounded DSL for exactly this hypothesis and its canonical features. Do not emit candidate metadata.' })
            const call = await client.invoke({ runId, stepId: '06_strategy_dsl', role: 'EXECUTION_ARCHITECT', messages,
              outputSchema: MODEL_OUTPUT_SCHEMAS.single_dsl, validate: validateSingleDsl, fixture: fixtureRows[index].dsl })
            const normalized: StrategyCandidate = { candidate_id: `CAND-${String(index + 1).padStart(2, '0')}`, run_id: runId,
              search_mode: hypothesis.search_mode, parent_strategy_id: hypothesis.parent_strategy_id, mutation_type: hypothesis.mutation_type,
              hypothesis: hypothesis.hypothesis, economic_mechanism: hypothesis.economic_mechanism, portfolio_gap: hypothesis.portfolio_gap,
              preferred_regimes: hypothesis.preferred_regimes, minimum_regime_samples: hypothesis.minimum_regime_samples,
              dsl: call.parsed as StrategyCandidate['dsl'], source_model: call.model_id, source_type: fixtureMode ? 'FIXTURE' : 'REAL', candidate_hash: '' }
            normalized.candidate_hash = await hashJson(normalized)
            return { candidate: normalized, raw: call.raw, prompt: messages }
          }))
          results.push(...batch)
        }
        const candidates = results.map((row) => row.candidate)
        await repository.saveCandidates(candidates)
        return { candidates, raw: results.map((row) => row.raw), prompt: results.map((row) => row.prompt) }
      } })

      const staticOutput = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 7, stepId: '07_static_validation', stepInput: { candidates: await hashJson(candidateOutput.candidates), input: frozen.manifest.input_hash }, compute: async () => {
        const output = await staticValidateCandidates({ candidates: candidateOutput.candidates, features: frozen.features, existingStrategies: frozen.strategies })
        if (output.allocation_errors.length) throw new Error(`candidate_allocation_failed:${output.allocation_errors.join(',')}`)
        await repository.saveStaticValidation(runId, output.results)
        return output
      } })

      const validCandidates = candidateOutput.candidates.filter((candidate) => staticOutput.results.find((row) => row.candidate_id === candidate.candidate_id)?.valid)
      if (!validCandidates.length) throw new Error('static_validation_no_valid_candidates')
      const shortlist = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 8, stepId: '08_candidate_shortlist', modelRole: 'PORTFOLIO_JUDGE', stepInput: { valid: await hashJson(validCandidates), gaps: await hashJson(gaps.gap_map) }, compute: async () => {
        const privacy = buildPrivacyShortlistPayload({ candidates: validCandidates, validation: staticOutput.results, existingStrategies: frozen.strategies, gapMap: gaps.gap_map })
        assertPrivacySafePayload(privacy.payload, [runId, ...validCandidates.map((row) => row.candidate_id), ...frozen.features.map((row) => row.feature_id), ...frozen.strategies.map((row) => row.strategy_id)])
        await artifacts.putJson(runId, 'privacy-identity-map-step08', privacy.identities, { local_only: true, privacy_contract: 'strategy-discovery-privacy-v1' })
        const messages = roleMessages('PORTFOLIO_JUDGE', privacy.payload)
        const call = await new StrategyDiscoveryWorkersAiClient(this.env.AI, repository, artifacts, fixtureMode).invoke({ runId, stepId: '08_candidate_shortlist', role: 'PORTFOLIO_JUDGE', messages,
          outputSchema: MODEL_OUTPUT_SCHEMAS.privacy_shortlist, validate: validatePrivacyShortlist,
          fixture: privacyFixtureShortlist(Object.values(privacy.identities.internal_to_opaque)) })
        const materialized = materializePrivacyShortlist({ runId, modelId: call.model_id, output: call.parsed, candidateIdentities: privacy.identities })
        const allowed = new Set(validCandidates.map((row) => row.candidate_id))
        const shortlistIds = [...new Set(materialized.shortlist_ids)]
        if (!shortlistIds.length || shortlistIds.length > 5 || shortlistIds.some((id) => !allowed.has(id))) throw new Error('shortlist_id_validation_failed')
        return { ...materialized, shortlist_ids: shortlistIds, raw: call.raw, prompt: messages, privacy_contract: 'strategy-discovery-privacy-v1' }
      } })

      const redTeam = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 9, stepId: '09_specialist_red_team', stepInput: { shortlist: shortlist.shortlist_ids, candidates: await hashJson(validCandidates) }, compute: async () => {
        const targets = validCandidates.filter((row) => shortlist.shortlist_ids.includes(row.candidate_id))
        const roles: PrivacyRole[] = ['DATA_PROSECUTOR', 'EXECUTION_PROSECUTOR', 'ECONOMIC_PROSECUTOR']
        const privacy = Object.fromEntries(roles.map((role) => [role, buildPrivacyRedTeamPayload({ role, targets, validation: staticOutput.results, features: frozen.features })])) as Record<PrivacyRole, ReturnType<typeof buildPrivacyRedTeamPayload>>
        for (const role of roles) {
          assertPrivacySafePayload(privacy[role].payload, [runId, ...targets.map((row) => row.candidate_id), ...frozen.features.map((row) => row.feature_id), ...frozen.strategies.map((row) => row.strategy_id)])
          await artifacts.putJson(runId, `privacy-identity-map-step09-${role.toLowerCase()}`, privacy[role].identities, { local_only: true, privacy_contract: 'strategy-discovery-privacy-v1' })
        }
        const prompts = Object.fromEntries(roles.map((role) => [role, roleMessages(role, privacy[role].payload)])) as Record<PrivacyRole, ReturnType<typeof roleMessages>>
        const client = new StrategyDiscoveryWorkersAiClient(this.env.AI, repository, artifacts, fixtureMode)
        const calls = await Promise.all(roles.map((role) => client.invoke({ runId, stepId: '09_specialist_red_team', role, messages: prompts[role],
          outputSchema: MODEL_OUTPUT_SCHEMAS.privacy_issues, validate: validatePrivacyIssueBatch,
          fixture: privacyFixtureIssueBatch(Object.values(privacy[role].identities.candidates.internal_to_opaque), role) })))
        const roleIssues = calls.map((call, index) => materializePrivacyIssues({ runId, modelId: call.model_id, issues: call.parsed.issues,
          candidateIdentities: privacy[roles[index]].identities.candidates, prefix: `RAW-${roles[index]}` }))
        const normalized = await normalizeAndMergeIssues(runId, [shortlist.issues, ...roleIssues])
        await repository.saveAuditIssues(normalized.issues, normalized.hashes)
        return { issues: normalized.issues, raw: Object.fromEntries(roles.map((role, index) => [role, calls[index].raw])), prompts, privacy_contract: 'strategy-discovery-privacy-v1' }
      } })

      const examined = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 10, stepId: '10_cross_examination', modelRole: 'CROSS_EXAMINER', stepInput: { issues: await hashJson(redTeam.issues) }, compute: async () => {
        const batches = buildPrivacyCrossExaminationBatches(redTeam.issues)
        const client = new StrategyDiscoveryWorkersAiClient(this.env.AI, repository, artifacts, fixtureMode)
        const materializedBatches: Array<ReturnType<typeof materializePrivacyCrossExamination>['assessments'][number]> = []
        const raw: Record<string, unknown> = {}
        const prompts: Record<string, ReturnType<typeof roleMessages>> = {}
        for (const batch of batches) {
          const batchId = String(batch.batch_index).padStart(2, '0')
          assertPrivacySafePayload(batch.payload, [runId, ...redTeam.issues.map((row) => row.issue_id), ...redTeam.issues.flatMap((row) => row.target_ids)])
          await artifacts.putJson(runId, `privacy-identity-map-step10-batch-${batchId}`, batch.identities, { local_only: true, privacy_contract: 'strategy-discovery-privacy-v1' })
          const messages = roleMessages('CROSS_EXAMINER', batch.payload)
          const call = await client.invoke({ runId, stepId: `10_cross_examination_batch_${batchId}`, role: 'CROSS_EXAMINER', messages,
            outputSchema: MODEL_OUTPUT_SCHEMAS.privacy_cross_examination, validate: validatePrivacyCrossExamination,
            fixture: privacyFixtureCrossExamination(Object.values(batch.identities.issues.internal_to_opaque), batch.issues) })
          const materializedBatch = materializePrivacyCrossExamination(call.parsed, batch.identities.issues)
          materializedBatches.push(...materializedBatch.assessments)
          await repository.saveCrossExaminations(runId, materializedBatch.assessments, call.model_id, fixtureMode ? 'FIXTURE' : 'REAL')
          raw[`batch_${batchId}`] = call.raw
          prompts[`batch_${batchId}`] = messages
        }
        const materialized = { assessments: materializedBatches }
        const known = new Set(redTeam.issues.map((row) => row.issue_id))
        const assessed = new Set(materialized.assessments.map((row) => row.issue_id))
        if (known.size !== assessed.size || [...known].some((id) => !assessed.has(id))) throw new Error('cross_examination_issue_coverage_mismatch')
        const issues = applyCrossExamination(redTeam.issues, materialized)
        const hashes = Object.fromEntries(await Promise.all(issues.map(async (row) => [row.issue_id, await hashJson(row)])))
        await repository.saveAuditIssues(issues, hashes)
        return { issues, cross_examination: materialized, raw, prompt: prompts, privacy_contract: 'strategy-discovery-privacy-v1' }
      } })

      const report = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 11, stepId: '11_cloud_report_and_bundle', stepInput: { issues: await hashJson(examined.issues), candidates: await hashJson(candidateOutput.candidates) }, compute: async () => {
        const cloudReport = { schema_version: STRATEGY_DISCOVERY_SCHEMA_VERSION, run_id: runId, fixture_mode: fixtureMode, disclaimer: fixtureMode ? 'FIXTURE STRUCTURAL EVIDENCE ONLY; NOT REAL MODEL EVIDENCE OR ALPHA PROOF' : 'Workers AI findings remain E0/E1 until Codex repository adjudication.', snapshot: frozen.manifest, feature_intelligence: featureIntelligence.deterministic, feature_map: featureIntelligence.feature_map, portfolio_gap_map: gaps.gap_map, hypotheses: hypothesisOutput.hypotheses, candidates: candidateOutput.candidates, static_validation: staticOutput, shortlist: { shortlist_ids: shortlist.shortlist_ids, rationale: shortlist.rationale }, issues: examined.issues, cross_examination: examined.cross_examination }
        const reportArtifact = await artifacts.putJson(runId, 'cloud-analysis-report', cloudReport, { fixture_mode: fixtureMode })
        const built = await buildJuryBundle({ manifest: frozen.manifest, features: frozen.features, strategies: frozen.strategies, intelligence: featureIntelligence.deterministic, featureMap: featureIntelligence.feature_map, gapMap: gaps.gap_map, hypotheses: hypothesisOutput.hypotheses, candidates: candidateOutput.candidates, staticValidation: staticOutput.results, shortlist: { shortlist_ids: shortlist.shortlist_ids, rationale: shortlist.rationale }, issues: examined.issues, crossExamination: examined.cross_examination,
          rawModelResponses: { FEATURE_LIBRARIAN: featureIntelligence.raw, ...hypothesisOutput.raw, EXECUTION_ARCHITECT: candidateOutput.raw, PORTFOLIO_JUDGE: shortlist.raw, ...redTeam.raw, CROSS_EXAMINER: examined.raw },
          promptTranscripts: { FEATURE_LIBRARIAN: featureIntelligence.prompt, ...hypothesisOutput.prompts, EXECUTION_ARCHITECT: candidateOutput.prompt, PORTFOLIO_JUDGE: shortlist.prompt, ...redTeam.prompts, CROSS_EXAMINER: examined.prompt }, createdAt: new Date().toISOString() })
        const bundleArtifact = await artifacts.putBytes({ runId, artifactType: 'jury-bundle', bytes: built.bytes, extension: 'zip', contentType: 'application/zip', metadata: { bundle_hash: built.manifest.bundle_hash, fixture_mode: fixtureMode, report_hash: reportArtifact.hash }, schemaVersion: STRATEGY_DISCOVERY_SCHEMA_VERSION })
        await repository.updateRun(runId, { status: 'CLOUD_ANALYSIS_COMPLETE', heartbeat: true })
        return { report_hash: reportArtifact.hash, bundle_artifact_hash: bundleArtifact.hash, bundle_hash: built.manifest.bundle_hash }
      } })

      const completed = await executeStep({ env: this.env, workflowStep, runId, workflowAttempt: attempt, index: 12, stepId: '12_complete', stepInput: report, compute: async () => ({ status: 'CODEX_HANDOFF_READY', ...report }) })
      await repository.updateRun(runId, { status: 'CODEX_HANDOFF_READY', completedSteps: 12, currentStep: null, heartbeat: true })
      return completed
    } catch (error) {
      const message = asError(error)
      const isBlocked = message.startsWith(BLOCKED)
      await repository.updateRun(runId, { status: isBlocked ? 'BLOCKED' : 'FAILED_RECOVERABLE', blockers: isBlocked ? [message.slice(BLOCKED.length)] : [], errorCode: isBlocked ? 'preflight_blocked' : 'workflow_failed', errorDetail: message, heartbeat: true }).catch(() => undefined)
      throw error
    }
  }
}
