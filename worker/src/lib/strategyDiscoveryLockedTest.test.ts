import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FeatureCard, StrategyCandidate } from '../strategy-discovery/domain'
import {
  validateLockedTestContract,
  validateParentMutationPairedComparison,
  type LockedTestContract,
  type ParentMutationPairedComparison,
} from '../strategy-discovery/lockedTestContract'

const HASH = 'a'.repeat(64)
const candidate: StrategyCandidate = {
  candidate_id: 'C-1', run_id: 'RUN-1', search_mode: 'MODE_B_PARENT_MUTATION',
  parent_strategy_id: 'P-1', mutation_type: 'ADD_GATE', hypothesis: 'h', economic_mechanism: 'e',
  portfolio_gap: 'g', preferred_regimes: ['bull'], minimum_regime_samples: 30,
  dsl: { feature_ids: ['tech_gap_up'], parameters: {}, regime_gate: null, entry_rules: [{}], exit_rules: [{}], signal_time: 'T_CLOSE', execution_time: 'T1_OPEN', falsification_condition: 'f', lags: [1] },
  candidate_hash: HASH, source_model: 'fixture', source_type: 'FIXTURE',
}
const verifiedFeature: FeatureCard = {
  feature_id: 'tech_gap_up', name: 'tech_gap_up', family: 'event', definition: 'known', data_source: ['runtime'],
  availability_lag: 'T+0_AFTER_DAILY_BAR_CLOSE', earliest_execution: 'T+1_MARKET_OPEN', lookback_days: 1,
  point_in_time: { status: 'VERIFIED', policy_version: 'v1', evidence_refs: ['repo:file'] },
  missing_rate: 'UNKNOWN', outlier_rate: 'UNKNOWN', turnover_proxy: 'UNKNOWN', correlation_cluster: 'UNKNOWN',
  ic_summary: {}, regime_summary: {}, factor_exposure: {}, used_by_strategies: [], known_risks: [],
  governance: { selector_role: 'core', promotion_state: 'candidate', materializer_status: 'ready', eligible_for_strategy: true },
}
const contract: LockedTestContract = {
  schema_version: 'strategy-discovery-locked-test-v1', run_id: 'RUN-1', candidate_id: 'C-1', candidate_hash: HASH,
  dataset_id: 'pit-prod-v1', dataset_hash: HASH, feature_snapshot_hash: HASH, strategy_snapshot_hash: HASH, universe_hash: HASH,
  train_range: ['2022-01-01', '2024-12-31'], test_range: ['2025-01-01', '2025-12-31'],
  label_horizon_days: 5, purge_days: 5, trial_count: 12, multiple_testing_correction: 'HOLM',
  metrics: ['annualized_return', 'max_drawdown'], thresholds: { annualized_return: 0.1 },
  cost_model: { commission_bps: 14.25, tax_bps: 30, slippage_bps: 10 }, locked_set_accessed: false,
  registered_at: '2026-07-14T00:00:00.000Z',
}

assert.deepEqual(validateLockedTestContract(contract, candidate, [verifiedFeature]), [])

const unknownFeature = { ...verifiedFeature, availability_lag: 'UNKNOWN' as const, point_in_time: { status: 'UNKNOWN' as const, policy_version: 'v1', evidence_refs: [] } }
assert(validateLockedTestContract(contract, candidate, [unknownFeature]).includes('locked_test_feature_point_in_time_unverified:tech_gap_up'))
assert(validateLockedTestContract({ ...contract, purge_days: 4 }, candidate, [verifiedFeature]).includes('locked_test_purge_below_label_horizon'))

const comparison: ParentMutationPairedComparison = {
  schema_version: 'strategy-discovery-parent-paired-comparison-v1', candidate_id: 'C-1', parent_strategy_id: 'P-1',
  candidate_hash: HASH, parent_hash: HASH, dataset_hash: HASH, universe_hash: HASH, split_hash: HASH, cost_model_hash: HASH,
  paired_date_count: 240, annualized_return_delta: 0.02, max_drawdown_delta: -0.01, selection_overlap: 0.72,
  confidence_interval_95: [0.005, 0.035],
}
assert.deepEqual(validateParentMutationPairedComparison(comparison, contract, candidate), [])
assert(validateParentMutationPairedComparison({ ...comparison, dataset_hash: 'b'.repeat(64) }, contract, candidate).includes('paired_comparison_dataset_mismatch'))

const generated = JSON.parse(readFileSync(resolve(process.cwd(), 'src/strategy-discovery/data/formal137-feature-registry.v1.json'), 'utf8'))
assert.equal(generated.pit_verified_feature_count, 3)
for (const featureId of ['tech_bullish_streak_5', 'tech_gap_down', 'tech_gap_up']) {
  const feature = generated.features.find((row: FeatureCard) => row.feature_id === featureId)
  assert.equal(feature.point_in_time.status, 'VERIFIED')
  assert.notEqual(feature.availability_lag, 'UNKNOWN')
}

console.log('strategyDiscoveryLockedTest.test.ts: PASS')
