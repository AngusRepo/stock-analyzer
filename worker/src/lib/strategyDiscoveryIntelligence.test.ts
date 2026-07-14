import assert from 'node:assert/strict'
import { hashJson } from '../strategy-discovery/hashing'
import { buildDeterministicFeatureIntelligence, buildPortfolioGapMap } from '../strategy-discovery/intelligence'
import { loadFeatureRegistrySnapshot } from '../strategy-discovery/featureRegistry'
import { staticValidateCandidates, validateHypothesisAllocation } from '../strategy-discovery/staticValidation'
import { UNKNOWN, type StrategyCandidate, type StrategyCard, type StrategyHypothesis } from '../strategy-discovery/domain'

function strategy(id: string, featureIds: string[], regimes: string[] = []): StrategyCard {
  return { strategy_id: id, version: 'v1', name: id, hypothesis: id, feature_ids: featureIds, entry_rules: [{}], exit_rules: [{}], holding_period: UNKNOWN, execution_timing: UNKNOWN, transaction_cost: UNKNOWN, preferred_regimes: regimes, failure_regimes: [], annual_performance: {}, regime_performance: {}, factor_exposure: {}, signal_correlation: {}, selection_overlap: {}, known_failures: [], source_references: [], governance: { status: 'active', owner_type: 'strategy', promotion_status: 'production', alpha_bucket: 'x', family_id: id, variant_id: '' } }
}

function hypotheses(runId: string): StrategyHypothesis[] {
  const modes = [...Array(6).fill('MODE_C_PORTFOLIO_GAP'), ...Array(4).fill('MODE_B_PARENT_MUTATION'), ...Array(2).fill('MODE_D_REGIME_SPECIALIST')] as StrategyHypothesis['search_mode'][]
  return modes.map((mode, index) => ({ hypothesis_id: `H${index + 1}`, run_id: runId, search_mode: mode, parent_strategy_id: mode === 'MODE_B_PARENT_MUTATION' ? 'S01' : null, mutation_type: mode === 'MODE_B_PARENT_MUTATION' ? 'ADD_GATE' : null, hypothesis: `Hypothesis ${index}`, economic_mechanism: 'testable mechanism', portfolio_gap: 'gap', preferred_regimes: mode === 'MODE_D_REGIME_SPECIALIST' ? ['bear'] : [], minimum_regime_samples: mode === 'MODE_D_REGIME_SPECIALIST' ? 100 : UNKNOWN, feature_ids: ['advance_ratio'], falsification_condition: 'reject if locked test fails', source_model: 'fixture', source_type: 'FIXTURE' }))
}

async function candidateFromHypothesis(hypothesis: StrategyHypothesis, index: number): Promise<StrategyCandidate> {
  const base: StrategyCandidate = { candidate_id: `C${index + 1}`, run_id: hypothesis.run_id, search_mode: hypothesis.search_mode, parent_strategy_id: hypothesis.parent_strategy_id, mutation_type: hypothesis.mutation_type, hypothesis: hypothesis.hypothesis, economic_mechanism: hypothesis.economic_mechanism, portfolio_gap: hypothesis.portfolio_gap, preferred_regimes: hypothesis.preferred_regimes, minimum_regime_samples: hypothesis.minimum_regime_samples, dsl: { feature_ids: [index === 0 ? 'advance_ratio' : `F-${index}`], parameters: { lookback: index + 2 }, regime_gate: null, entry_rules: [{ op: 'gt', value: index }], exit_rules: [{ op: 'time', days: index + 2 }], signal_time: 'T_CLOSE', execution_time: 'T_PLUS_1_OPEN', falsification_condition: hypothesis.falsification_condition, lags: [1] }, candidate_hash: '', source_model: 'fixture', source_type: 'FIXTURE' }
  base.candidate_hash = await hashJson({ ...base, candidate_hash: '' })
  return base
}

async function main() {
  const featureSnapshot = await loadFeatureRegistrySnapshot({ advance_ratio: ['S01', 'S02'] })
  const strategies = [strategy('S01', ['advance_ratio'], ['bull']), strategy('S02', ['advance_ratio'], ['bull'])]
  const intelligence = buildDeterministicFeatureIntelligence(featureSnapshot.cards, strategies)
  assert.equal(intelligence.feature_usage_frequency.advance_ratio, 2)
  assert.deepEqual(intelligence.exact_feature_duplicate_groups, [['S01', 'S02']])
  const gaps = buildPortfolioGapMap(featureSnapshot.cards, strategies, intelligence)
  assert.ok(gaps.missing_regimes.includes('bear'))
  assert.deepEqual(gaps.highly_correlated_strategy_groups, [['S01', 'S02']])
  assert.deepEqual(validateHypothesisAllocation(hypotheses('RUN-1')), [])
  assert.ok(validateHypothesisAllocation(hypotheses('RUN-1').slice(1)).some((error) => error.startsWith('candidate_count_mismatch')))
  const badParent = hypotheses('RUN-1'); badParent[6] = { ...badParent[6], mutation_type: null }
  assert.ok(validateHypothesisAllocation(badParent).some((error) => error.startsWith('hypothesis_parent_mutation_lineage')))
  const badRegime = hypotheses('RUN-1'); badRegime[10] = { ...badRegime[10], minimum_regime_samples: UNKNOWN }
  assert.ok(validateHypothesisAllocation(badRegime).some((error) => error.startsWith('hypothesis_regime_sample_gate')))

  const rows = await Promise.all(hypotheses('RUN-1').map(candidateFromHypothesis))
  const featureIds = new Set(featureSnapshot.cards.map((feature) => feature.feature_id))
  for (const row of rows) if (!featureIds.has(row.dsl.feature_ids[0])) row.dsl.feature_ids = [featureSnapshot.cards[(Number(row.candidate_id.slice(1)) * 3) % featureSnapshot.cards.length].feature_id]
  for (const row of rows) row.candidate_hash = await hashJson({ ...row, candidate_hash: '' })
  const validated = await staticValidateCandidates({ candidates: rows, features: featureSnapshot.cards, existingStrategies: strategies })
  assert.deepEqual(validated.allocation_errors, [])
  assert.equal(validated.results.length, 12)
  assert.ok(validated.results.every((result) => result.valid))
  assert.ok(validated.results.every((result) => result.warnings.some((warning) => warning.startsWith('feature_timing_unknown_positive_lag_guard'))))

  rows[0].dsl.lags = [0]
  rows[0].candidate_hash = await hashJson({ ...rows[0], candidate_hash: '' })
  const unsafe = await staticValidateCandidates({ candidates: rows, features: featureSnapshot.cards, existingStrategies: strategies })
  assert.ok(unsafe.results[0].errors.includes('unknown_feature_timing_requires_positive_lag:advance_ratio'))
  rows[0].dsl.lags = [1]
  rows[1].dsl = structuredClone(rows[0].dsl)
  rows[0].candidate_hash = await hashJson({ ...rows[0], candidate_hash: '' })
  rows[1].candidate_hash = await hashJson({ ...rows[1], candidate_hash: '' })
  const duplicate = await staticValidateCandidates({ candidates: rows, features: featureSnapshot.cards, existingStrategies: strategies })
  assert.ok(duplicate.results[1].errors.includes('candidate_structural_duplicate:C1'))
}

void main()
