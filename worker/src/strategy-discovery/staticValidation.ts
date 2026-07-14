import { SEARCH_POLICY } from './config'
import { hashJson } from './hashing'
import { UNKNOWN, type FeatureCard, type StaticValidationResult, type StrategyCandidate, type StrategyCard, type StrategyHypothesis } from './domain'
import { validateCandidate } from './validators'

function allocationErrors<T extends { search_mode: keyof typeof SEARCH_POLICY.allocation }>(rows: T[]): string[] {
  const errors: string[] = []
  if (rows.length !== SEARCH_POLICY.candidate_count) errors.push(`candidate_count_mismatch:${rows.length}:${SEARCH_POLICY.candidate_count}`)
  for (const [mode, expected] of Object.entries(SEARCH_POLICY.allocation)) {
    const actual = rows.filter((row) => row.search_mode === mode).length
    if (actual !== expected) errors.push(`search_allocation_mismatch:${mode}:${actual}:${expected}`)
  }
  return errors
}

export function validateHypothesisAllocation(hypotheses: StrategyHypothesis[]): string[] {
  const errors = allocationErrors(hypotheses)
  const ids = new Set<string>()
  for (const hypothesis of hypotheses) {
    if (ids.has(hypothesis.hypothesis_id)) errors.push(`duplicate_hypothesis_id:${hypothesis.hypothesis_id}`)
    ids.add(hypothesis.hypothesis_id)
    if (!hypothesis.hypothesis || !hypothesis.economic_mechanism || !hypothesis.falsification_condition) errors.push(`hypothesis_required_fields:${hypothesis.hypothesis_id}`)
    if (hypothesis.feature_ids.length < 1 || hypothesis.feature_ids.length > 3) errors.push(`hypothesis_feature_limit:${hypothesis.hypothesis_id}`)
    if (hypothesis.search_mode === 'MODE_B_PARENT_MUTATION' && (!hypothesis.parent_strategy_id || !hypothesis.mutation_type)) errors.push(`hypothesis_parent_mutation_lineage:${hypothesis.hypothesis_id}`)
    if (hypothesis.search_mode !== 'MODE_B_PARENT_MUTATION' && hypothesis.mutation_type !== null) errors.push(`hypothesis_mutation_mode:${hypothesis.hypothesis_id}`)
    if (hypothesis.search_mode === 'MODE_D_REGIME_SPECIALIST' && (hypothesis.minimum_regime_samples === UNKNOWN || Number(hypothesis.minimum_regime_samples) <= 0)) errors.push(`hypothesis_regime_sample_gate:${hypothesis.hypothesis_id}`)
  }
  return errors
}

function structuralFingerprint(candidate: StrategyCandidate): string {
  return JSON.stringify({ features: [...new Set(candidate.dsl.feature_ids)].sort(), entry: candidate.dsl.entry_rules, exit: candidate.dsl.exit_rules, signal: candidate.dsl.signal_time, execution: candidate.dsl.execution_time })
}

function existingFeatureFingerprint(strategy: StrategyCard): string {
  return [...new Set(strategy.feature_ids)].sort().join('|')
}

function timingErrors(candidate: StrategyCandidate, featureMap: ReadonlyMap<string, FeatureCard>): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  for (const [index, featureId] of candidate.dsl.feature_ids.entries()) {
    const card = featureMap.get(featureId)
    if (!card) continue
    const lag = candidate.dsl.lags[index] ?? candidate.dsl.lags[0]
    if ((card.availability_lag === UNKNOWN || card.earliest_execution === UNKNOWN) && (!Number.isInteger(lag) || lag < 1)) errors.push(`unknown_feature_timing_requires_positive_lag:${featureId}`)
    else if (card.availability_lag === UNKNOWN || card.earliest_execution === UNKNOWN) warnings.push(`feature_timing_unknown_positive_lag_guard:${featureId}`)
  }
  if (candidate.dsl.signal_time === candidate.dsl.execution_time) errors.push('same_bar_signal_execution_forbidden')
  return { errors, warnings }
}

export async function staticValidateCandidates(input: { candidates: StrategyCandidate[]; features: FeatureCard[]; existingStrategies: StrategyCard[] }): Promise<{ allocation_errors: string[]; results: StaticValidationResult[] }> {
  const allocation_errors = allocationErrors(input.candidates)
  const knownFeatures = new Set(input.features.map((feature) => feature.feature_id))
  const featureMap = new Map(input.features.map((feature) => [feature.feature_id, feature]))
  const existingFingerprints = new Set(input.existingStrategies.map(existingFeatureFingerprint).filter(Boolean))
  const fingerprints = new Map<string, string>()
  const ids = new Set<string>()
  const results: StaticValidationResult[] = []
  for (const candidate of input.candidates) {
    const errors = validateCandidate(candidate, knownFeatures)
    const warnings: string[] = []
    if (candidate.run_id !== input.candidates[0]?.run_id) errors.push('candidate_run_id_mismatch')
    if (ids.has(candidate.candidate_id)) errors.push('candidate_duplicate_id')
    ids.add(candidate.candidate_id)
    const actualHash = await hashJson({ ...candidate, candidate_hash: '' })
    if (candidate.candidate_hash !== actualHash) errors.push('candidate_hash_mismatch')
    const timing = timingErrors(candidate, featureMap)
    errors.push(...timing.errors)
    warnings.push(...timing.warnings)
    const structure = structuralFingerprint(candidate)
    if (fingerprints.has(structure)) errors.push(`candidate_structural_duplicate:${fingerprints.get(structure)}`)
    else fingerprints.set(structure, candidate.candidate_id)
    const featuresOnly = [...new Set(candidate.dsl.feature_ids)].sort().join('|')
    if (featuresOnly && existingFingerprints.has(featuresOnly)) warnings.push('candidate_feature_set_matches_existing_strategy')
    results.push({ candidate_id: candidate.candidate_id, candidate_hash: candidate.candidate_hash, valid: errors.length === 0, errors, warnings })
  }
  return { allocation_errors, results }
}
