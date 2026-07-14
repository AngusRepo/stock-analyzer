import { UNKNOWN, type FeatureCard, type StrategyCandidate } from './domain'

export type MultipleTestingCorrection = 'BONFERRONI' | 'HOLM' | 'BENJAMINI_HOCHBERG'

export interface LockedTestContract {
  schema_version: 'strategy-discovery-locked-test-v1'
  run_id: string
  candidate_id: string
  candidate_hash: string
  dataset_id: string
  dataset_hash: string
  feature_snapshot_hash: string
  strategy_snapshot_hash: string
  universe_hash: string
  train_range: [string, string]
  test_range: [string, string]
  label_horizon_days: number
  purge_days: number
  trial_count: number
  multiple_testing_correction: MultipleTestingCorrection
  metrics: string[]
  thresholds: Record<string, number>
  cost_model: { commission_bps: number; tax_bps: number; slippage_bps: number }
  locked_set_accessed: false
  registered_at: string
}

export interface ParentMutationPairedComparison {
  schema_version: 'strategy-discovery-parent-paired-comparison-v1'
  candidate_id: string
  parent_strategy_id: string
  candidate_hash: string
  parent_hash: string
  dataset_hash: string
  universe_hash: string
  split_hash: string
  cost_model_hash: string
  paired_date_count: number
  annualized_return_delta: number
  max_drawdown_delta: number
  selection_overlap: number
  confidence_interval_95: [number, number]
}

const SHA256 = /^[a-f0-9]{64}$/

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function validateLockedTestContract(
  contract: LockedTestContract,
  candidate: StrategyCandidate,
  features: FeatureCard[],
): string[] {
  const errors: string[] = []
  if (contract.schema_version !== 'strategy-discovery-locked-test-v1') errors.push('locked_test_schema_version_invalid')
  if (contract.run_id !== candidate.run_id) errors.push('locked_test_run_id_mismatch')
  if (contract.candidate_id !== candidate.candidate_id) errors.push('locked_test_candidate_id_mismatch')
  if (contract.candidate_hash !== candidate.candidate_hash) errors.push('locked_test_candidate_hash_mismatch')
  for (const [name, value] of Object.entries({
    candidate_hash: contract.candidate_hash,
    dataset_hash: contract.dataset_hash,
    feature_snapshot_hash: contract.feature_snapshot_hash,
    strategy_snapshot_hash: contract.strategy_snapshot_hash,
    universe_hash: contract.universe_hash,
  })) if (!SHA256.test(value)) errors.push(`locked_test_${name}_invalid`)
  if (!contract.dataset_id.trim()) errors.push('locked_test_dataset_id_missing')
  if (contract.train_range[0] > contract.train_range[1]) errors.push('locked_test_train_range_invalid')
  if (contract.test_range[0] > contract.test_range[1] || contract.train_range[1] >= contract.test_range[0]) errors.push('locked_test_test_range_invalid')
  if (!Number.isInteger(contract.label_horizon_days) || contract.label_horizon_days < 1) errors.push('locked_test_label_horizon_invalid')
  if (!Number.isInteger(contract.purge_days) || contract.purge_days < contract.label_horizon_days) errors.push('locked_test_purge_below_label_horizon')
  if (!Number.isInteger(contract.trial_count) || contract.trial_count < 1) errors.push('locked_test_trial_count_invalid')
  if (!['BONFERRONI', 'HOLM', 'BENJAMINI_HOCHBERG'].includes(contract.multiple_testing_correction)) errors.push('locked_test_multiple_testing_correction_invalid')
  if (!contract.metrics.length || !Object.keys(contract.thresholds).length) errors.push('locked_test_metrics_or_thresholds_missing')
  if (Object.values(contract.thresholds).some((value) => !Number.isFinite(value))) errors.push('locked_test_threshold_invalid')
  if (Object.values(contract.cost_model).some((value) => !isFiniteNonNegative(value))) errors.push('locked_test_cost_model_invalid')
  if (contract.locked_set_accessed !== false) errors.push('locked_test_already_accessed')
  if (!Number.isFinite(Date.parse(contract.registered_at))) errors.push('locked_test_registered_at_invalid')

  const featureMap = new Map(features.map((feature) => [feature.feature_id, feature]))
  for (const featureId of candidate.dsl.feature_ids) {
    const feature = featureMap.get(featureId)
    if (!feature) {
      errors.push(`locked_test_feature_missing:${featureId}`)
      continue
    }
    if (
      feature.availability_lag === UNKNOWN
      || feature.earliest_execution === UNKNOWN
      || feature.point_in_time?.status !== 'VERIFIED'
      || !feature.point_in_time.evidence_refs.length
    ) errors.push(`locked_test_feature_point_in_time_unverified:${featureId}`)
  }
  if (candidate.search_mode === 'MODE_B_PARENT_MUTATION' && !candidate.parent_strategy_id) errors.push('locked_test_parent_strategy_missing')
  return errors
}

export function validateParentMutationPairedComparison(
  comparison: ParentMutationPairedComparison,
  contract: LockedTestContract,
  candidate: StrategyCandidate,
): string[] {
  const errors: string[] = []
  if (candidate.search_mode !== 'MODE_B_PARENT_MUTATION') return ['paired_comparison_not_parent_mutation']
  if (comparison.schema_version !== 'strategy-discovery-parent-paired-comparison-v1') errors.push('paired_comparison_schema_version_invalid')
  if (comparison.candidate_id !== candidate.candidate_id || comparison.candidate_hash !== candidate.candidate_hash) errors.push('paired_comparison_candidate_mismatch')
  if (!candidate.parent_strategy_id || comparison.parent_strategy_id !== candidate.parent_strategy_id) errors.push('paired_comparison_parent_mismatch')
  for (const [name, value] of Object.entries({
    parent_hash: comparison.parent_hash,
    dataset_hash: comparison.dataset_hash,
    universe_hash: comparison.universe_hash,
    split_hash: comparison.split_hash,
    cost_model_hash: comparison.cost_model_hash,
  })) if (!SHA256.test(value)) errors.push(`paired_comparison_${name}_invalid`)
  if (comparison.dataset_hash !== contract.dataset_hash) errors.push('paired_comparison_dataset_mismatch')
  if (comparison.universe_hash !== contract.universe_hash) errors.push('paired_comparison_universe_mismatch')
  if (!Number.isInteger(comparison.paired_date_count) || comparison.paired_date_count < 30) errors.push('paired_comparison_insufficient_dates')
  if (![comparison.annualized_return_delta, comparison.max_drawdown_delta].every(Number.isFinite)) errors.push('paired_comparison_delta_invalid')
  if (!Number.isFinite(comparison.selection_overlap) || comparison.selection_overlap < 0 || comparison.selection_overlap > 1) errors.push('paired_comparison_selection_overlap_invalid')
  const [lower, upper] = comparison.confidence_interval_95
  if (![lower, upper].every(Number.isFinite) || lower > upper) errors.push('paired_comparison_confidence_interval_invalid')
  return errors
}

export const LOCKED_TEST_CONTRACT_SCHEMA = {
  schema_version: 'strategy-discovery-locked-test-v1',
  required: [
    'candidate_hash', 'dataset_hash', 'feature_snapshot_hash', 'strategy_snapshot_hash', 'universe_hash',
    'train_range', 'test_range', 'label_horizon_days', 'purge_days', 'trial_count',
    'multiple_testing_correction', 'metrics', 'thresholds', 'cost_model', 'locked_set_accessed',
  ],
  invariants: [
    'purge_days >= label_horizon_days',
    'locked_set_accessed == false at registration',
    'every candidate feature has repository-backed VERIFIED point-in-time evidence',
  ],
} as const

export const PARENT_MUTATION_PAIRED_COMPARISON_SCHEMA = {
  schema_version: 'strategy-discovery-parent-paired-comparison-v1',
  required: [
    'parent_hash', 'candidate_hash', 'dataset_hash', 'universe_hash', 'split_hash', 'cost_model_hash',
    'paired_date_count', 'annualized_return_delta', 'max_drawdown_delta', 'selection_overlap', 'confidence_interval_95',
  ],
  invariants: ['same dataset', 'same universe', 'same split dates', 'same cost model', 'paired_date_count >= 30'],
} as const
