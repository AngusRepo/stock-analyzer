import { MODEL_REGISTRY } from './config'
import { UNKNOWN, type AuditIssue, type DeterministicFeatureIntelligence, type FeatureCard, type PortfolioGapMap, type RegimeSampleEvidence, type StrategyCandidate, type StrategyCard, type StrategyHypothesis } from './domain'
import type { CrossExaminationOutput, FeatureMapOutput, IssueBatchOutput, ShortlistOutput } from './modelContracts'

function selectedFeatures(features: FeatureCard[]): FeatureCard[] {
  const core = features.filter((feature) => feature.governance.selector_role === 'core_prior')
  return (core.length >= 12 ? core : features).slice(0, 12)
}

export function fixtureFeatureMap(intelligence: DeterministicFeatureIntelligence): FeatureMapOutput {
  return { summary: 'Fixture-only structural feature map; no statistical performance claim.', cluster_observations: intelligence.feature_clusters.slice(0, 12).map((cluster) => ({ cluster_id: cluster.cluster_id, summary: `${cluster.feature_count} registered features; ${cluster.used_feature_count} used.`, duplicate_feature_ids: [], coverage_gaps: cluster.used_feature_count === 0 ? ['unused_cluster'] : [] })), limitations: intelligence.limitations }
}

export function fixtureHypotheses(input: { runId: string; features: FeatureCard[]; strategies: StrategyCard[]; gaps: PortfolioGapMap; regimes: RegimeSampleEvidence[] }): { mistral: { hypotheses: StrategyHypothesis[] }; gemma: { hypotheses: StrategyHypothesis[] } } {
  const features = selectedFeatures(input.features)
  const c = Array.from({ length: 6 }, (_, index): StrategyHypothesis => ({
    hypothesis_id: `H-C-${index + 1}`, run_id: input.runId, search_mode: 'MODE_C_PORTFOLIO_GAP', parent_strategy_id: null, mutation_type: null,
    hypothesis: `Test whether ${features[index].feature_id} supplies a structurally unused portfolio signal.`, economic_mechanism: `Feature family ${features[index].family} may respond to a currently underrepresented mechanism.`,
    portfolio_gap: input.gaps.unused_feature_clusters[index % Math.max(1, input.gaps.unused_feature_clusters.length)] ?? 'holding_period_evidence_gap', preferred_regimes: [], minimum_regime_samples: UNKNOWN,
    feature_ids: [features[index].feature_id], falsification_condition: 'Reject when locked out-of-sample evidence does not improve predefined portfolio contribution after costs.',
    source_model: MODEL_REGISTRY.HYPOTHESIS_SCIENTIST.model, source_type: 'FIXTURE',
  }))
  const mutations: StrategyHypothesis['mutation_type'][] = ['ADD_GATE', 'REPLACE_FEATURE', 'MODIFY_EXIT', 'REDUCE_TURNOVER']
  const b = Array.from({ length: 4 }, (_, index): StrategyHypothesis => ({
    hypothesis_id: `H-B-${index + 1}`, run_id: input.runId, search_mode: 'MODE_B_PARENT_MUTATION', parent_strategy_id: input.strategies[index].strategy_id, mutation_type: mutations[index],
    hypothesis: `Apply one ${mutations[index]} mutation to ${input.strategies[index].strategy_id}.`, economic_mechanism: 'One isolated mutation permits causal comparison against the unchanged parent.',
    portfolio_gap: 'parent_ablation_evidence', preferred_regimes: input.strategies[index].preferred_regimes, minimum_regime_samples: UNKNOWN,
    feature_ids: [features[index + 6].feature_id], falsification_condition: 'Reject unless the locked paired test beats the unchanged parent under identical costs.',
    source_model: MODEL_REGISTRY.HYPOTHESIS_SCIENTIST.model, source_type: 'FIXTURE',
  }))
  const eligibleRegimes = [...input.regimes].filter((row) => row.max_samples > 0).sort((a, b) => b.max_samples - a.max_samples).slice(0, 2)
  const d = eligibleRegimes.map((regime, index): StrategyHypothesis => ({
    hypothesis_id: `H-D-${index + 1}`, run_id: input.runId, search_mode: 'MODE_D_REGIME_SPECIALIST', parent_strategy_id: null, mutation_type: null,
    hypothesis: `Test a fixed ${regime.regime} specialist using point-in-time regime state.`, economic_mechanism: `The fixed ${regime.regime} family may change the payoff of ${features[index + 10].feature_id}.`,
    portfolio_gap: 'regime_specific_horizon_evidence', preferred_regimes: [regime.regime], minimum_regime_samples: regime.max_samples,
    feature_ids: [features[index + 10].feature_id], falsification_condition: 'Reject when the locked regime slice misses its preregistered minimum effect or sample gate.',
    source_model: MODEL_REGISTRY.REGIME_EXPLORER.model, source_type: 'FIXTURE',
  }))
  return { mistral: { hypotheses: [...c, ...b] }, gemma: { hypotheses: d } }
}

export function fixtureCandidates(runId: string, hypotheses: StrategyHypothesis[]): { candidates: StrategyCandidate[] } {
  return { candidates: hypotheses.map((row, index) => ({ candidate_id: `CAND-${String(index + 1).padStart(3, '0')}`, run_id: runId, search_mode: row.search_mode, parent_strategy_id: row.parent_strategy_id, mutation_type: row.mutation_type, hypothesis: row.hypothesis, economic_mechanism: row.economic_mechanism, portfolio_gap: row.portfolio_gap, preferred_regimes: row.preferred_regimes, minimum_regime_samples: row.minimum_regime_samples, dsl: { feature_ids: row.feature_ids, parameters: { lookback_days: index + 2 }, regime_gate: row.search_mode === 'MODE_D_REGIME_SPECIALIST' ? { family: row.preferred_regimes[0] } : null, entry_rules: [{ op: 'gt', feature: row.feature_ids[0], threshold_ref: `P${index + 1}` }], exit_rules: [{ op: 'max_holding_days', value: index + 2 }], signal_time: 'T_CLOSE', execution_time: 'T_PLUS_1_OPEN', falsification_condition: row.falsification_condition, lags: row.feature_ids.map(() => 1) }, candidate_hash: '', source_model: MODEL_REGISTRY.EXECUTION_ARCHITECT.model, source_type: 'FIXTURE' })) }
}

function fixtureIssue(runId: string, targetId: string, model: string, category: string): AuditIssue {
  return { issue_id: `RAW-${category}-${targetId}`, run_id: runId, target_type: 'CANDIDATE', target_ids: [targetId], category, claim: `Fixture ${category} claim requires repository verification.`, attack_mechanism: category, observed_evidence: [], missing_evidence: ['repository evidence', 'executable test'], severity_if_true: 'MAJOR', evidence_level: 'E1', critic_model: model, critic_confidence: 0.6, falsification_test: { required: true }, blocks_if_confirmed: true, cross_exam_status: 'POSSIBLE_BUT_UNVERIFIED', duplicate_of: null }
}

export function fixtureShortlist(runId: string, candidates: StrategyCandidate[]): ShortlistOutput {
  const ids = candidates.slice(0, 5).map((row) => row.candidate_id)
  return { shortlist_ids: ids, issues: [fixtureIssue(runId, ids[0], MODEL_REGISTRY.PORTFOLIO_JUDGE.model, 'MULTIPLE_TESTING')], rationale: 'Fixture shortlist validates structure only and is not an Alpha claim.' }
}

export function fixtureIssueBatch(runId: string, targetId: string, role: 'DATA_PROSECUTOR' | 'EXECUTION_PROSECUTOR' | 'ECONOMIC_PROSECUTOR'): IssueBatchOutput {
  return { issues: [fixtureIssue(runId, targetId, MODEL_REGISTRY[role].model, role)] }
}

export function fixtureCrossExamination(issues: AuditIssue[]): CrossExaminationOutput {
  return { assessments: issues.map((issue) => ({ issue_id: issue.issue_id, status: 'POSSIBLE_BUT_UNVERIFIED', severity_if_true: issue.severity_if_true, missing_evidence: issue.missing_evidence, duplicate_of: null })) }
}
