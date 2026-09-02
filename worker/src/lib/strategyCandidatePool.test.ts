import { DEFAULT_STRATEGY_SPECS, STRATEGY_SPEC_VERSION } from './strategySpec'
import {
  DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY,
  buildLayer1StrategyBreadthPlan,
  buildStrategyCandidatePools,
  mergeStrategyCandidatePools,
  passesLayer1TopUpQualityGuard,
  planStrategyFirstCandidateSelection,
  resolveStrategyCapacityBudget,
  type StrategyCandidatePoolCandidate,
} from './strategyCandidatePool'
import { ACTIVE_8_ML_TEACHERS, STRATEGY_AFFINITY_CHALLENGER_VERSION, STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION, assessStrategyThresholdMarginAffinity, buildMultiStrategyPleRoutingPlan, buildStrategySimilarityEvidencePayload } from './multiStrategyPleRouter'
import { coerceModalStrategySimilarityGraphEvidence } from './strategyPortfolioMetrics'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function scoreV2Payload(input: {
  finalScore?: number
  chipFlow: number
  technicalStructure: number
  momentumScore: number
  mlEdge?: number
  fundamentalQuality?: number
  newsTheme?: number
}): string {
  const payload: Record<string, unknown> = {
    version: 'score_v2',
    components: {
      mlEdge: input.mlEdge ?? 12,
      chipFlow: input.chipFlow,
      technicalStructure: input.technicalStructure,
      fundamentalQuality: input.fundamentalQuality ?? 10,
      newsTheme: input.newsTheme ?? 2,
    },
    technicalBreakdown: {
      trendStructure: 6,
      volatilityStructure: 4,
      reversalExtreme: 4,
      volumeConfirmation: Math.min(6, input.momentumScore),
      executionRisk: 1,
    },
    seedComponents: {
      screenerMomentumSeed20: input.momentumScore,
    },
  }
  if (input.finalScore != null) payload.finalScore = input.finalScore
  return JSON.stringify(payload)
}

function rawSignalPayload(input: {
  close?: number
  closeAboveMa20Pct?: number
  closeAboveMa60Pct?: number
  volumeExpansion20?: number
  return20d?: number
  foreignTrustNet5d?: number
  brokerNetAmount5d?: number
  brokerCount?: number
  brokerConcentration?: number
  revenueGrowthYoY?: number
  monthlyRevenueYoY?: number
  roe?: number
  eps?: number
  pe?: number
  pb?: number
} = {}) {
  return {
    close: input.close ?? 50,
    closeAboveMa20Pct: input.closeAboveMa20Pct ?? 0.03,
    closeAboveMa60Pct: input.closeAboveMa60Pct ?? 0.01,
    volumeExpansion20: input.volumeExpansion20 ?? 1.25,
    return20d: input.return20d ?? 0.06,
    foreignTrustNet5d: input.foreignTrustNet5d ?? 1200,
    brokerNetAmount5d: input.brokerNetAmount5d ?? 10_000_000,
    brokerCount: input.brokerCount ?? 8,
    brokerConcentration: input.brokerConcentration ?? 0.4,
    revenueGrowthYoY: input.revenueGrowthYoY ?? 8,
    monthlyRevenueYoY: input.monthlyRevenueYoY ?? 10,
    roe: input.roe ?? 12,
    eps: input.eps ?? 1.8,
    pe: input.pe ?? 18,
    pb: input.pb ?? 2,
  }
}

const candidates: StrategyCandidatePoolCandidate[] = Array.from({ length: 90 }, (_, index) => {
  const n = index + 1
  const finalScore = 72 - index * 0.15
  const chipFlow = index % 4 === 0 ? 24 : 19
  const technicalStructure = 24 - (index % 5)
  const momentumScore = 12 - (index % 3)
  return {
    symbol: `${2300 + n}`,
    name: `Stock ${n}`,
    industry: index % 3 === 0 ? 'Semiconductor' : index % 3 === 1 ? 'Network' : 'Other',
    score_components: scoreV2Payload({ finalScore, chipFlow, technicalStructure, momentumScore }),
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: 0.01 + (index % 5) * 0.01,
      volumeExpansion20: 0.95 + (index % 6) * 0.08,
      return20d: 0.01 + (index % 4) * 0.02,
      foreignTrustNet5d: index % 4 === 0 ? 2200 : 500,
      brokerCount: 4 + (index % 8),
      brokerConcentration: 0.25 + (index % 4) * 0.08,
    }),
    current_price: 30 + index,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
})

{
  const fragileNoSupport: StrategyCandidatePoolCandidate = {
    symbol: '1215',
    name: 'Fragile No Support',
    industry: 'Food',
    score: 5.8,
    chip_score: 0,
    tech_score: 9,
    current_price: 125,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
    raw_signals: {
      close: 125,
      closeAboveMa20Pct: -0.092,
      closeAboveMa60Pct: -0.092,
      volumeExpansion20: 1.56,
      foreignTrustNet5d: -1_574_161,
      brokerNetAmount5d: 0,
      brokerCount: null,
      monthlyRevenueYoY: 7.54,
      roe: 3.38,
      eps: 1.26,
      technicalIndicators: { rsi14: 36.7 },
      factorSignals: { rsi14: 36.7, foreignTrustNet5d: -1_574_161, brokerNetAmount5d: 0, brokerCount: null },
    },
  }
  const constructiveTopUp: StrategyCandidatePoolCandidate = {
    ...fragileNoSupport,
    symbol: '8998',
    name: 'Constructive Top Up',
    chip_score: 12,
    tech_score: 17,
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: -0.01,
      closeAboveMa60Pct: 0.02,
      volumeExpansion20: 1.25,
      foreignTrustNet5d: 1500,
      brokerNetAmount5d: 8_000_000,
      brokerCount: 5,
      brokerConcentration: 0.4,
    }),
  }

  assert(!passesLayer1TopUpQualityGuard(fragileNoSupport), 'fragile technicals plus unsupported chip flow must not enter L1 through top-up')
  assert(passesLayer1TopUpQualityGuard(constructiveTopUp), 'constructive raw technical/chip evidence should remain eligible for qualified L1 top-up')
}

{
  const lowScoreDiverseCandidate: StrategyCandidatePoolCandidate = {
    symbol: '8999',
    name: 'Low Score Strategy Fit',
    industry: 'Niche',
    score: 1,
    score_components: scoreV2Payload({
      finalScore: 76,
      chipFlow: 25,
      technicalStructure: 24,
      momentumScore: 12,
    }),
    raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.06, volumeExpansion20: 1.45, return20d: 0.1 }),
    current_price: 40,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
  const scoreCrowd: StrategyCandidatePoolCandidate[] = Array.from({ length: 40 }, (_, index) => ({
    symbol: `${5000 + index}`,
    name: `Score Crowd ${index}`,
    industry: 'Crowded',
    score: 100 - index,
    score_components: scoreV2Payload({
      finalScore: 42,
      chipFlow: 8,
      technicalStructure: 8,
      momentumScore: 2,
    }),
    raw_signals: rawSignalPayload({ closeAboveMa20Pct: -0.08, volumeExpansion20: 0.6, return20d: -0.1 }),
    current_price: 40,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }))
  const nicheSpec = {
    id: 'niche_strategy_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Niche strategy',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Niche strategy should source L1 breadth directly from full feature-enriched universe.',
    thresholds: { minCloseAboveMa20Pct: 0.03, minVolumeExpansion20: 1.2, minReturn20d: 0.03, includeIndustries: ['Niche'], minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8, maxMlShare: 0 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const oldTopScoreSymbols = new Set(
    [...scoreCrowd, lowScoreDiverseCandidate]
      .sort((a, b) => Number((b as any).score ?? 0) - Number((a as any).score ?? 0))
      .slice(0, 20)
      .map((candidate) => candidate.symbol),
  )

  const plan = buildLayer1StrategyBreadthPlan(
    [...scoreCrowd, lowScoreDiverseCandidate],
    [nicheSpec],
    {
      targetSize: 20,
      coarseMlQueueSize: 8,
      regime: 'bull',
    },
  )

  assert(!oldTopScoreSymbols.has('8999'), 'test fixture must keep niche candidate outside old score-top pool')
  assert(plan.breadthPool.some((candidate) => candidate.symbol === '8999'), 'L1 breadth pool should include raw-signal priced strategy fit outside old score-top pool')
  assert(plan.telemetry.selection_order === 'full_feature_enriched_universe_strategy_only_no_raw_signal_forced_fill', 'L1 selection order must not force-fill ML breadth with raw-signal observe evidence')
  assert(plan.coarseQueue.every((candidate: any) => candidate.strategy_pool_decision === 'ml_queue'), 'Layer2 coarse queue should contain formal strategy hits before controller-side coarse ML pruning')
  assert(Number((plan.telemetry as any).coarse_ml_target_size) === 8, 'Layer2 coarse queue should preserve the controller target size as telemetry')
  assert(plan.coarseQueue.every((candidate: any) => candidate.strategy_pool_fallback_source !== 'raw_signal_top_up'), 'raw-signal top-up must not enter formal L2 coarse queue')
}

{
  const broadCandidates: StrategyCandidatePoolCandidate[] = Array.from({ length: 36 }, (_, index) => ({
    symbol: `${6200 + index}`,
    name: `Adaptive ${index}`,
    industry: index % 3 === 0 ? 'AI' : index % 3 === 1 ? 'Power' : 'Finance',
    score_components: scoreV2Payload({ finalScore: 58 + (index % 5), chipFlow: 18, technicalStructure: 19, momentumScore: 8 }),
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: 0.04 + (index % 4) * 0.005,
      volumeExpansion20: 1.25,
      return20d: 0.045,
      foreignTrustNet5d: 500 + index,
      brokerCount: 5,
      revenueGrowthYoY: 10,
      monthlyRevenueYoY: 12,
      roe: 10,
    }),
    current_price: 30 + index,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }))
  const broadSpec = {
    id: 'adaptive_soft_capacity_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Adaptive soft capacity',
    status: 'active' as const,
    owner: 'strategy' as const,
    familyId: 'TREND_RECLAIM_CONTINUATION' as const,
    variantId: 'adaptive_soft_capacity_v1',
    ownerType: 'strategy' as const,
    promotionStatus: 'production' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Soft capacity should adapt above baseline when route evidence is broad.',
    thresholds: { minPrice: 10, minCloseAboveMa20Pct: 0.01 },
    candidatePolicy: { poolQuota: 20, costBudget: 20 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }

  const plan = buildLayer1StrategyBreadthPlan(broadCandidates, [broadSpec], {
    targetSize: 12,
    coarseMlQueueSize: 8,
    regime: 'bull',
  })

  assert((plan.telemetry as any).soft_capacity_baseline === 12, 'L1.5 targetSize should be a soft baseline, not a hard top-k cap')
  assert((plan.telemetry as any).adaptive_capacity_policy === 'authority_aware_decision_universe_no_capacity_admission', 'L1.5 capacity policy must follow formal route authority')
  assert(Number((plan.telemetry as any).adaptive_target_size) > 12, 'L1.5 should expand above soft baseline when broad quality-floor evidence exists')
  assert(Number((plan.telemetry as any).adaptive_target_size_before_dynamic_quota) > 12, 'L1.5 should preserve the pre-dynamic adaptive target for audit')
  assert((plan.telemetry as any).dynamic_effective_quota_policy === 'telemetry_only_not_candidate_admission', 'dynamic strategy quotas must be telemetry only and cannot remove candidates')
  assert(plan.breadthPool.length === plan.coarseQueue.length, 'every route-floor candidate must remain in the L1 decision universe')
  assert(Number((plan.telemetry as any).adaptive_target_size) === plan.coarseQueue.length, 'adaptive target telemetry must report actual route-floor breadth')
  assert(Number((plan.telemetry as any).soft_capacity_reference_target) > 12, 'soft capacity reference remains telemetry only')
  assert((plan.telemetry as any).strategy_matrix_candidate_count === broadCandidates.length, 'soft capacity must not reduce full-universe strategy labeling scope')
  assert((plan.telemetry as any).strategy_matrix_cell_count === broadCandidates.length, 'single-strategy matrix should still evaluate every candidate')
  assert((plan.telemetry as any).route_gate_authority === 'continuous_weight_unvalidated', 'breadth telemetry must carry the continuous-weight authority receipt')
  assert((plan.telemetry as any).route_veto_applied === false, 'unvalidated route must remain non-vetoing through the outer capacity layer')
  assert(Number((plan.telemetry as any).adaptive_capacity_eligible_count) === Number((plan.telemetry as any).strategy_matrix_active_labeled_candidate_count), 'unvalidated capacity must use the active-strategy universe, not diagnostic floor-pass count')
  assert(plan.coarseQueue.every((candidate: any) => candidate.strategy_router_decision === 'ml_slate'), 'all active-strategy candidates should remain formal evidence before route promotion')
}

{
  const broadCandidates: StrategyCandidatePoolCandidate[] = Array.from({ length: 16 }, (_, index) => ({
    symbol: `${6100 + index}`,
    name: `Broad ${index}`,
    industry: index === 15 ? 'Niche' : 'Crowded',
    score_components: scoreV2Payload({ finalScore: 55, chipFlow: 16, technicalStructure: 18, momentumScore: 7 }),
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: index === 15 ? 0.08 : 0.015,
      volumeExpansion20: index === 15 ? 1.55 : 1.05,
      return20d: index === 15 ? 0.12 : 0.02,
      foreignTrustNet5d: index === 15 ? 3000 : 300,
      brokerCount: index === 15 ? 9 : 4,
      revenueGrowthYoY: index === 15 ? 16 : 2,
      monthlyRevenueYoY: index === 15 ? 18 : 3,
      roe: index === 15 ? 18 : 6,
    }),
    current_price: 40 + index,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }))
  const broadSpec = {
    id: 'broad_everything_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Broad everything',
    status: 'active' as const,
    owner: 'strategy' as const,
    familyId: 'TREND_RECLAIM_CONTINUATION' as const,
    variantId: 'broad_everything_v1',
    ownerType: 'strategy' as const,
    promotionStatus: 'production' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Broad strategy should be treated as crowded portfolio evidence.',
    thresholds: { minPrice: 10 },
    candidatePolicy: { poolQuota: 20, costBudget: 20 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const nicheSpec = {
    ...broadSpec,
    id: 'niche_quality_breakout_v1',
    name: 'Niche quality breakout',
    familyId: 'REVENUE_QUALITY_MOMENTUM' as const,
    variantId: 'niche_quality_breakout_v1',
    alphaBucket: 'breakout_vol_expansion' as const,
    thesis: 'Niche candidate adds low-crowding family support.',
    thresholds: { minPrice: 10, includeIndustries: ['Niche'], minCloseAboveMa20Pct: 0.05, minVolumeExpansion20: 1.4, minRevenueGrowthYoY: 8 },
  }
  const plan = buildMultiStrategyPleRoutingPlan(broadCandidates, [broadSpec, nicheSpec], {
    maxSlateSize: 3,
    regime: 'bull',
  })
  assert(plan.mlSlate.length === plan.telemetry.active_labeled_candidates, 'unvalidated L1.5 route score must not censor active strategy candidates')
  assert(plan.telemetry.capacity_policy === 'continuous_weight_full_active_strategy_universe', 'L1.5 must preserve the full active-strategy universe')
  assert(plan.telemetry.route_gate_authority === 'continuous_weight_unvalidated', 'unvalidated route must expose continuous-weight-only authority')
  assert(plan.telemetry.route_veto_applied === false && plan.telemetry.route_veto_candidate_count === 0, 'unvalidated route must never veto a candidate')
  assert(plan.telemetry.route_priority_only_candidate_count === plan.telemetry.route_score_below_floor_count, 'below-floor rows must remain priority diagnostics before promotion')
  assert(plan.telemetry.slate_selection_policy === 'l15-continuous-full-universe-priority-v3', 'L1.5 router must use rank only for dispatch priority, not top-k admission')
  assert(plan.telemetry.strategy_matrix_candidate_count === broadCandidates.length, 'L1 label matrix candidate count must follow runtime L0 universe size')
  assert(plan.telemetry.strategy_matrix_strategy_count === [broadSpec, nicheSpec].length, 'L1 label matrix strategy dimension must follow current strategy count')
  assert(plan.telemetry.strategy_matrix_cell_count === broadCandidates.length * [broadSpec, nicheSpec].length, 'L1 label matrix must cover runtime candidates x current strategies')
  assert(plan.telemetry.strategy_matrix_coverage_ratio === 1, 'L1 label matrix coverage must be complete')
  assert(plan.telemetry.min_route_score_source === 'adaptive_route_score_distribution', 'L1.5 route floor should be adaptive by score distribution when config does not override it')
  assert(plan.telemetry.strategy_metric_status_counts.no_evidence === 2, 'L1.25 must expose missing immutable performance evidence without manufacturing matrix-derived statistics')
  assert(plan.mlSlate.some((candidate) => candidate.symbol === '6115'), 'FinLab-style portfolio intelligence should let niche multi-family support survive broad crowded labels')
  const niche = plan.mlSlate.find((candidate) => candidate.symbol === '6115') as any
  assert(niche.strategy_router_version === 'multi-strategy-policy-router-v2', 'routed candidate should expose L1.5 router provenance')
  assert(niche.strategy_affinity_version === 'strategy-raw-quality-affinity-v1', 'incumbent production affinity semantics must remain explicit')
  assert(niche.strategy_challenger_affinity_version === 'strategy-threshold-margin-affinity-v2', 'challenger must expose strategy-specific threshold-margin semantics')
  assert(niche.strategy_router_reason === 'l15_unvalidated_continuous_weight_dispatch_priority', 'unvalidated route must expose continuous priority semantics')
  assert(niche.marginal_utility_score != null, 'L1.5 selected candidate should expose marginal utility score')
  assert(niche.strategy_router_components?.marginal_utility_score != null, 'L1.5 selected candidate should persist marginal utility components')
  assert((niche.strategy_family_ids ?? []).length === 2, 'niche candidate should retain cross-family strategy evidence')
  assert(Object.keys(niche.strategy_hit_vector ?? {}).length === [broadSpec, nicheSpec].length, 'L1 labeler must expose full current-strategy matrix width')
  assert(niche.strategy_weak_label_vector?.broad_everything_v1 != null, 'L1 labeler must expose weak labels per strategy')
  assert(niche.strategy_hit_vector?.niche_quality_breakout_v1 === 1, 'L1 labeler must expose strategy hits per strategy')
  assert(niche.strategy_position_weight_vector?.niche_quality_breakout_v1 > 0, 'L1 labeler must expose position-weight style strategy attribution')
  assert(niche.family_exposure?.REVENUE_QUALITY_MOMENTUM != null, 'L1.5 router must expose family exposure')
  assert(niche.diversity_contribution != null && niche.risk_adjusted_affinity != null && niche.uncertainty != null, 'L1.5 router must expose diversity/risk/uncertainty outputs')
  assert(niche.strategy_router_components?.strategy_crowding_score != null, 'L1.25 FinLab-style prior must feed router crowding components')
  assert(niche.strategy_portfolio_prior?.strategy_metrics?.niche_quality_breakout_v1?.prior_weight != null, 'L1.25 prior must expose strategy-as-asset metrics')
  assert(plan.telemetry.strategy_similarity_evidence_source === 'missing', 'L1.25 must not synthesize Worker-local graph evidence when Modal evidence is absent')
  assert(plan.telemetry.strategy_similarity_algorithm_owner === 'not_computed', 'missing L1.25 graph evidence must not claim a Worker algorithm owner')
  assert(plan.telemetry.strategy_similarity_component_count === 0, 'missing L1.25 graph evidence must not expose synthetic strategy components')
  assert(plan.telemetry.strategy_similarity_effective_strategy_count === 0, 'missing L1.25 graph evidence must not expose synthetic effective strategy count')
  assert(plan.telemetry.strategy_similarity_blocked_reason === 'modal_python_strategy_similarity_evidence_missing', 'missing Modal L1.25 evidence must be explicit')
  assert(niche.strategy_portfolio_prior?.strategy_similarity_graph?.evidence_only === true, 'strategy similarity graph must remain evidence-only')
  assert(!('selected' in (niche.strategy_portfolio_prior?.strategy_similarity_graph ?? {})), 'strategy similarity graph must not become a selector')

  const promotedPlan = buildMultiStrategyPleRoutingPlan(broadCandidates, [broadSpec, nicheSpec], {
    maxSlateSize: 3,
    regime: 'bull',
    promotedRouteCalibration: {
      runId: 'route-calibration-test',
      routeVersion: STRATEGY_EVIDENCE_ALIGNED_ROUTE_VERSION,
      routeFloor: 100,
    },
  })
  assert(promotedPlan.telemetry.route_gate_authority === 'continuous_weight_promoted', 'a promoted v3 route may own continuous weights but not admission')
  assert(promotedPlan.telemetry.route_veto_applied === false, 'route calibration must never become candidate admission')
  assert(promotedPlan.mlSlate.length === promotedPlan.telemetry.active_labeled_candidates, 'all active-strategy candidates must survive route scoring')
  assert(promotedPlan.telemetry.route_veto_candidate_count === 0, 'no route score may veto a candidate')
  assert(promotedPlan.telemetry.route_priority_only_candidate_count === promotedPlan.telemetry.route_score_below_floor_count, 'floor remains diagnostic only')
}

{
  const marginCandidate: StrategyCandidatePoolCandidate = {
    symbol: '7777',
    name: 'Margin Candidate',
    industry: 'Test',
    current_price: 50,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
    score_components: scoreV2Payload({ finalScore: 70, chipFlow: 20, technicalStructure: 20, momentumScore: 10 }),
    raw_signals: rawSignalPayload({ return20d: 0.1 }),
  }
  const baseSpec = {
    id: 'loose_margin_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Loose margin',
    status: 'active' as const,
    owner: 'strategy' as const,
    familyId: 'TREND_RECLAIM_CONTINUATION' as const,
    variantId: 'loose_margin_v1',
    ownerType: 'strategy' as const,
    promotionStatus: 'production' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Test strategy-specific threshold distance.',
    thresholds: { minPrice: 10, minReturn20d: 0.01 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const tightSpec = {
    ...baseSpec,
    id: 'tight_margin_v1',
    name: 'Tight margin',
    familyId: 'REVENUE_QUALITY_MOMENTUM' as const,
    variantId: 'tight_margin_v1',
    thresholds: { minPrice: 10, minReturn20d: 0.099 },
  }
  const similarity = coerceModalStrategySimilarityGraphEvidence({
    schema_version: 'strategy-similarity-evidence-v1',
    status: 'computed',
    source: 'modal_python',
    algorithm_owner: 'ml-service-modal-python',
    graph_algorithm: 'networkx.Graph+networkx.connected_components',
    method: 'networkx_connected_components_oof_residual_correlation',
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    eligible_oof_pair_count: 1,
    paired_date_max: 8,
    oof_max_date: '2026-07-08',
    medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
    medoid_scope: 'connected_component',
    evidence_only: true,
    global_k_hardcoded: false,
    production_selector: false,
    self_implemented_algorithm: false,
    kmedoids_pam_preflight_status: 'pass',
    kmedoids_pam_preflight: { status: 'pass', self_implemented_fallback: false },
    strategy_count: 2,
    edge_count: 1,
    component_count: 1,
    effective_strategy_count: 1,
    edge_threshold: 0.8,
    edge_threshold_source: 'adaptive_quantile',
    strategy_cluster_id: { loose_margin_v1: 'sc000', tight_margin_v1: 'sc000' },
    strategy_cluster_size: { loose_margin_v1: 2, tight_margin_v1: 2 },
    strategy_cluster_crowding_score: { loose_margin_v1: 0.9, tight_margin_v1: 0.9 },
    strategy_cluster_uniqueness_score: { loose_margin_v1: 0.1, tight_margin_v1: 0.1 },
    medoid_strategy_by_cluster: { sc000: 'loose_margin_v1' },
  })
  assert(similarity, 'test similarity evidence must satisfy the Modal contract')
  const plan = buildMultiStrategyPleRoutingPlan([marginCandidate], [baseSpec, tightSpec], {
    maxSlateSize: 1,
    regime: 'bull',
    minRouteScore: 0,
    strategySimilarityGraphEvidence: similarity,
    previousSlateSymbols: ['7777', '8888'],
  })
  const routed = plan.l0Annotated[0] as any
  const looseProjection = assessStrategyThresholdMarginAffinity(marginCandidate, baseSpec, { regime: 'bull' })
  const tightProjection = assessStrategyThresholdMarginAffinity(marginCandidate, tightSpec, { regime: 'bull' })
  const legacyWeightedProjection = assessStrategyThresholdMarginAffinity(marginCandidate, baseSpec, {
    regime: 'bull',
    strategyWeights: { [baseSpec.id]: 0.5 },
  })
  const formalWeightedProjection = assessStrategyThresholdMarginAffinity(marginCandidate, baseSpec, {
    regime: 'bull',
    strategyWeights: { [baseSpec.id]: 1 },
    productionStrategyWeights: { [baseSpec.id]: 0.5 },
  })
  assert(looseProjection.challengerAffinity === routed.strategy_challenger_affinity_vector.loose_margin_v1, 'shared PIT projector must equal native loose-strategy affinity')
  assert(tightProjection.challengerAffinity === routed.strategy_challenger_affinity_vector.tight_margin_v1, 'shared PIT projector must equal native tight-strategy affinity')
  assert(legacyWeightedProjection.productionWeight === 1, 'legacy strategyWeights-only callers must not apply the configured weight twice')
  assert(legacyWeightedProjection.challengerAffinity === formalWeightedProjection.challengerAffinity, 'legacy configured weight and explicit production multiplier must preserve equivalent single-weight routing')
  assert(routed.strategy_affinity_vector.loose_margin_v1 === routed.strategy_affinity_vector.tight_margin_v1, 'incumbent affinity must remain unchanged until challenger promotion')
  assert(routed.strategy_challenger_affinity_vector.loose_margin_v1 > routed.strategy_challenger_affinity_vector.tight_margin_v1, 'challenger affinity must follow each strategy threshold margin')
  assert(routed.strategy_router_components.challenger_raw_active_strategy_support > routed.strategy_router_components.challenger_residualized_active_strategy_support, 'correlated strategy hits must receive diminishing challenger support')
  assert(routed.strategy_router_components.challenger_effective_strategy_support_count === 1, 'same similarity cluster must count as one effective challenger support owner')
  assert(plan.telemetry.temporal_jaccard === 0.5, 'router must expose cross-day slate Jaccard without using it as a selector')
  assert(plan.telemetry.previous_list_recall === 0.5, 'router must expose previous-list recall')
  assert(plan.telemetry.fresh_share === 0, 'router must expose fresh share independently of Jaccard')
}

{
  const candidate: StrategyCandidatePoolCandidate = {
    symbol: '7766',
    name: 'Alpha lineage candidate',
    industry: 'Test',
    current_price: 50,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
    score_components: scoreV2Payload({ finalScore: 70, chipFlow: 20, technicalStructure: 20, momentumScore: 10 }),
    raw_signals: rawSignalPayload({ return20d: 0.1 }),
  }
  const alphaA = {
    id: 'alpha223_a',
    version: STRATEGY_SPEC_VERSION,
    name: 'Alpha223 A',
    status: 'active' as const,
    owner: 'strategy' as const,
    familyId: 'ALPHA223_CASH_GAP_BROKER_FLOW' as const,
    variantId: 'alpha223_a',
    ownerType: 'strategy' as const,
    promotionStatus: 'production' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Alpha223 parent-lineage variant A.',
    thresholds: { minPrice: 10, minReturn20d: 0.01 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const alphaB = {
    ...alphaA,
    id: 'alpha223_b',
    name: 'Alpha223 B',
    familyId: 'ALPHA223_QUALITY_TURNOVER' as const,
    variantId: 'alpha223_b',
    thesis: 'Alpha223 parent-lineage variant B.',
  }
  const singletonGraph = coerceModalStrategySimilarityGraphEvidence({
    schema_version: 'strategy-similarity-evidence-v1',
    status: 'computed',
    source: 'modal_python',
    algorithm_owner: 'ml-service-modal-python',
    graph_algorithm: 'networkx.Graph+networkx.connected_components',
    method: 'networkx_connected_components_oof_residual_correlation',
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    eligible_oof_pair_count: 1,
    paired_date_max: 8,
    oof_max_date: '2026-07-08',
    medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
    medoid_scope: 'connected_component',
    evidence_only: true,
    global_k_hardcoded: false,
    production_selector: false,
    self_implemented_algorithm: false,
    kmedoids_pam_preflight_status: 'pass',
    kmedoids_pam_preflight: { status: 'pass', self_implemented_fallback: false },
    strategy_count: 2,
    edge_count: 0,
    component_count: 2,
    effective_strategy_count: 2,
    edge_threshold: 0.8,
    edge_threshold_source: 'adaptive_quantile',
    strategy_cluster_id: { alpha223_a: 'sc000', alpha223_b: 'sc001' },
    strategy_cluster_size: { alpha223_a: 1, alpha223_b: 1 },
    strategy_cluster_crowding_score: { alpha223_a: 0, alpha223_b: 0 },
    strategy_cluster_uniqueness_score: { alpha223_a: 1, alpha223_b: 1 },
    medoid_strategy_by_cluster: { sc000: 'alpha223_a', sc001: 'alpha223_b' },
  })
  assert(singletonGraph, 'singleton Modal graph fixture must satisfy the evidence contract')
  const plan = buildMultiStrategyPleRoutingPlan([candidate], [alphaA, alphaB], {
    maxSlateSize: 1,
    regime: 'bull',
    minRouteScore: 0,
    strategySimilarityGraphEvidence: singletonGraph,
  })
  const routed = plan.l0Annotated[0] as any
  assert(routed.strategy_router_components.challenger_effective_strategy_support_count === 2, 'Modal OOF graph, not strategy naming, must own independent support count')
  assert(Object.values(routed.strategy_raw_position_weight_vector).filter((value: any) => value > 0).length === 2, 'raw attribution must retain both Alpha223 matches')
  assert(Object.values(routed.strategy_position_weight_vector).filter((value: any) => value > 0).length === 2, 'incumbent production weights must remain unchanged before challenger promotion')
  assert(Object.values(routed.strategy_challenger_position_weight_vector).filter((value: any) => value > 0).length === 2, 'challenger must follow the independent Modal evidence without ID-prefix consolidation')
}

{
  const plan = buildMultiStrategyPleRoutingPlan(candidates.slice(0, 8), [], {
    maxSlateSize: 6,
    regime: 'bull',
  })
  assert(plan.mlSlate.length === 0, 'L1.5 router must not backfill formal ML slate when no active strategy labels exist')
  assert(plan.observeOnly.length === 8, 'unrouted candidates should remain observable for research/audit')
}

{
  const hotCandidate: StrategyCandidatePoolCandidate = {
    symbol: '8801',
    name: 'Hot Relative Strength',
    industry: 'Momentum',
    score_components: scoreV2Payload({ finalScore: 68, chipFlow: 18, technicalStructure: 20, momentumScore: 14 }),
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: 0.09,
      closeAboveMa60Pct: 0.13,
      volumeExpansion20: 2.15,
      return20d: 0.18,
      foreignTrustNet5d: 3200,
      brokerNetAmount5d: 22_000_000,
      brokerCount: 9,
      revenueGrowthYoY: 9,
      monthlyRevenueYoY: 11,
      roe: 12,
    }),
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
  const quietCandidate: StrategyCandidatePoolCandidate = {
    symbol: '8802',
    name: 'Quiet Quality',
    industry: 'Momentum',
    score_components: scoreV2Payload({ finalScore: 72, chipFlow: 20, technicalStructure: 21, momentumScore: 3 }),
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: 0.01,
      closeAboveMa60Pct: 0.01,
      volumeExpansion20: 0.95,
      return20d: 0.01,
      foreignTrustNet5d: 400,
      brokerNetAmount5d: 1_000_000,
      brokerCount: 3,
      revenueGrowthYoY: 13,
      monthlyRevenueYoY: 14,
      roe: 16,
    }),
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
  const broadSpec = {
    id: 'market_heat_broad_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Market heat broad evidence',
    status: 'active' as const,
    owner: 'strategy' as const,
    familyId: 'TREND_RECLAIM_CONTINUATION' as const,
    variantId: 'market_heat_broad_v1',
    ownerType: 'strategy' as const,
    promotionStatus: 'production' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Heat should be a router feature, not a hard quota.',
    thresholds: { minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8, maxMlShare: 0 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }

  const plan = buildMultiStrategyPleRoutingPlan([quietCandidate, hotCandidate], [broadSpec], {
    maxSlateSize: 1,
    minRouteScore: 0,
    regime: 'bull',
  })
  const annotated = [...plan.mlSlate, ...plan.observeOnly] as any[]
  const hot = annotated.find((candidate) => candidate.symbol === '8801') as any
  const quiet = annotated.find((candidate) => candidate.symbol === '8802') as any

  assert(plan.mlSlate.length === 2, 'market heat must not turn max dispatch size into candidate admission')
  assert(plan.telemetry.capacity_policy === 'continuous_weight_full_active_strategy_universe', 'market heat must remain evidence and must not become a candidate-removal quota')
  assert(hot.strategy_router_components.market_heat_score > quiet.strategy_router_components.market_heat_score, 'hot candidate should expose stronger market heat evidence')
  assert(hot.strategy_router_components.market_heat_contribution > quiet.strategy_router_components.market_heat_contribution, 'market heat must remain observable as diagnostic evidence')
  assert(hot.strategy_router_components.market_heat_alpha === 0, 'market heat must not own expected-return rank')
  assert(hot.strategy_router_components.context_rank_neutralized === 1, 'L1 context must be cross-sectionally rank-neutral in the challenger')
  assert(plan.mlSlate.every((candidate) => (candidate.strategy_router_components?.continuous_weight_multiplier ?? 0) > 0), 'all eligible candidates must retain a positive continuous weight')
  const largeUniverse = Array.from({ length: 291 }, (_, index) => ({
    ...quietCandidate,
    symbol: `9${String(index).padStart(3, '0')}`,
    name: `Route floor candidate ${index}`,
  }))
  const largePlan = buildMultiStrategyPleRoutingPlan(largeUniverse, [broadSpec], {
    maxSlateSize: 160,
    minRouteScore: 0,
    regime: 'bull',
  })
  assert(largePlan.mlSlate.length === 291, '291 route-floor eligible candidates must not be silently truncated to the legacy 160 capacity')
  assert(largePlan.observeOnly.every((candidate) => candidate.strategy_router_decision !== 'capacity_overflow'), 'capacity_overflow must not remain an admission outcome')
}

{
  assert(ACTIVE_8_ML_TEACHERS.length === 8, 'L1.5 router must preserve 8ML teacher-label contract')
  assert(ACTIVE_8_ML_TEACHERS.includes('LightGBM') && !ACTIVE_8_ML_TEACHERS.includes('TimesFM' as any), '8ML teacher-label contract must keep TimesFM out of direct teachers')

  const strongCandidate: StrategyCandidatePoolCandidate = {
    symbol: '7701',
    name: 'Reliable Strategy Candidate',
    industry: 'Reliable',
    score_components: scoreV2Payload({ finalScore: 70, chipFlow: 22, technicalStructure: 24, momentumScore: 11 }),
    raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.07, volumeExpansion20: 1.5, return20d: 0.12, revenueGrowthYoY: 18 }),
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
  const weakCandidate: StrategyCandidatePoolCandidate = {
    ...strongCandidate,
    symbol: '7702',
    name: 'Crowded Strategy Candidate',
    industry: 'Crowded',
  }
  const reliableSpec = {
    id: 'reliable_low_corr_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Reliable low correlation',
    status: 'active' as const,
    owner: 'strategy' as const,
    familyId: 'REVENUE_QUALITY_MOMENTUM' as const,
    variantId: 'reliable_low_corr_v1',
    ownerType: 'strategy' as const,
    promotionStatus: 'production' as const,
    alphaBucket: 'breakout_vol_expansion' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Reliable low-correlation strategy should receive higher L1.25 prior.',
    thresholds: { includeIndustries: ['Reliable'], minPrice: 10, minCloseAboveMa20Pct: 0.03 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const crowdedSpec = {
    ...reliableSpec,
    id: 'crowded_low_sharpe_v1',
    name: 'Crowded low sharpe',
    familyId: 'TREND_RECLAIM_CONTINUATION' as const,
    variantId: 'crowded_low_sharpe_v1',
    alphaBucket: 'trend_following' as const,
    thesis: 'Crowded low-reliability strategy should be down-weighted by L1.25.',
    thresholds: { includeIndustries: ['Crowded'], minPrice: 10, minCloseAboveMa20Pct: 0.03 },
  }
  const plan = buildMultiStrategyPleRoutingPlan([weakCandidate, strongCandidate], [crowdedSpec, reliableSpec], {
    maxSlateSize: 2,
    regime: 'bull',
    runtimeTeacherEvidence: {
      '7701': { LightGBM: 0.8, XGBoost: 0.75, ExtraTrees: 0.72, TabM: 0.7, GNN: 0.68, DLinear: 0.66, PatchTST: 0.64, iTransformer: 0.62 },
    },
    strategyPortfolioMetrics: {
      reliable_low_corr_v1: {
        strategy_metric_status: 'ready',
        metric_sources: ['immutable-test-artifact'],
        rolling_sharpe: 1.4,
        max_drawdown: 0.08,
        recent_alpha: 0.08,
        return_correlation: 0.15,
        holding_overlap: 0.1,
        turnover: 0.18,
        factor_crowding: 0.12,
        rank_ic: 0.12,
        live_backtest_divergence: 0.05,
      },
      crowded_low_sharpe_v1: {
        strategy_metric_status: 'ready',
        metric_sources: ['immutable-test-artifact'],
        rolling_sharpe: -0.4,
        max_drawdown: 0.34,
        recent_alpha: -0.04,
        return_correlation: 0.82,
        holding_overlap: 0.76,
        turnover: 0.7,
        factor_crowding: 0.78,
        rank_ic: -0.03,
        live_backtest_divergence: 0.32,
      },
    },
  })
  const annotated = [...plan.mlSlate, ...plan.observeOnly] as any[]
  const reliable = annotated.find((candidate) => candidate.symbol === '7701') as any
  const crowded = annotated.find((candidate) => candidate.symbol === '7702') as any
  assert(reliable && crowded, 'router should annotate both candidates even when quality floor blocks one from formal slate')
  assert(plan.telemetry.strategy_matrix_candidate_count === 2, 'L1 matrix candidate count must be runtime-derived')
  assert(plan.telemetry.strategy_matrix_strategy_count === 2, 'L1 matrix strategy count must be runtime-derived')
  assert(plan.telemetry.strategy_matrix_cell_count === 4, 'L1 matrix cell count must equal candidates x strategies')
  assert(Object.keys(reliable.strategy_hit_vector ?? {}).length === 2, 'L1 matrix vector must include all current strategies')
  assert(reliable.strategy_hit_vector.crowded_low_sharpe_v1 === 0, 'L1 matrix must encode non-hit strategies as zero instead of omitting the column')
  assert(reliable.strategy_router_decision === 'ml_slate', 'reliable low-correlation support should enter formal L1.5 slate')
  assert(reliable.candidate_route_score > crowded.candidate_route_score, 'L1.25 reliability/diversification prior should outrank crowded low-sharpe support')
  assert(reliable.runtime_teacher_evidence.LightGBM === 0.8, 'L1.5 should carry optional historical runtime teacher evidence')
  assert(reliable.runtime_teacher_evidence_source === 'historical_verified_cache', 'L1.5 runtime teacher evidence should expose historical verified cache source')
  assert(reliable.ml_teacher_labels.LightGBM === 0.8, 'L1.5 should keep ml_teacher_labels only as legacy funnel alias')
  assert(plan.telemetry.min_route_score_source === 'adaptive_route_score_distribution', 'L1.5 should not silently default to hardcoded 20 when minRouteScore is absent')
  assert(plan.telemetry.teacher_label_available_count === 1, 'L1.5 telemetry should count candidates with teacher evidence')
  assert(plan.telemetry.teacher_label_missing_count === 1, 'L1.5 telemetry should count candidates missing teacher evidence')
  assert(reliable.strategy_router_components.teacher_alignment > crowded.strategy_router_components.teacher_alignment, 'teacher labels should improve router evidence without replacing 8ML')
  assert(crowded.strategy_router_components.teacher_alignment === 0, 'missing teacher labels must not receive neutral 0.5 alignment')
  assert(crowded.strategy_router_components.teacher_alignment_contribution === 0, 'missing teacher labels must not add route-score contribution')
  assert(crowded.strategy_router_components.teacher_alignment_missing === 1, 'missing teacher labels must be explicit telemetry')
  assert(reliable.strategy_portfolio_prior.strategy_reliability.reliable_low_corr_v1 > reliable.strategy_portfolio_prior.strategy_reliability.crowded_low_sharpe_v1, 'FinLab-style prior must expose strategy reliability spread')
  assert(Object.keys(reliable.strategy_portfolio_prior.strategy_cluster_crowding_score ?? {}).length === 0, 'missing Modal L1.25 evidence must not expose synthetic graph cluster crowding')
  assert(reliable.strategy_portfolio_prior.effective_strategy_count === 0, 'missing Modal L1.25 evidence must not expose synthetic graph effective strategy count')

  const neutralPlan = buildMultiStrategyPleRoutingPlan([weakCandidate, strongCandidate], [crowdedSpec, reliableSpec], {
    maxSlateSize: 2,
    regime: 'bull',
  })
  const forgedPlan = buildMultiStrategyPleRoutingPlan([weakCandidate, strongCandidate], [crowdedSpec, reliableSpec], {
    maxSlateSize: 2,
    regime: 'bull',
    strategyPortfolioMetrics: {
      reliable_low_corr_v1: {
        rolling_sharpe: 99,
        recent_alpha: 1,
        ic: 1,
        rank_ic: 1,
        shapley_contribution: 1,
        reliability: 1,
        prior_weight: 1.8,
      },
    },
  })
  const neutralCandidate = [...neutralPlan.mlSlate, ...neutralPlan.observeOnly].find((candidate) => candidate.symbol === '7701') as any
  const forgedCandidate = [...forgedPlan.mlSlate, ...forgedPlan.observeOnly].find((candidate) => candidate.symbol === '7701') as any
  assert(forgedCandidate.strategy_portfolio_prior.strategy_metric_status.reliable_low_corr_v1 === 'no_evidence', 'unattested formal metrics must be unavailable')
  assert(forgedCandidate.candidate_route_score === neutralCandidate.candidate_route_score, 'unattested Sharpe/IC/Shapley must not change route score')
  assert(forgedCandidate.strategy_router_components.strategy_reliability === neutralCandidate.strategy_router_components.strategy_reliability, 'unattested metrics must stay neutral downstream')
}

{
  const pools = buildStrategyCandidatePools(candidates, DEFAULT_STRATEGY_SPECS, { regime: 'bull' })
  assert(
    pools.length === DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status !== 'retired').length,
    'planner should create one pool per non-retired strategy',
  )
  assert(pools.some((pool) => pool.candidates.length > 0), 'at least one strategy should propose candidates before global merge')
  assert(pools.every((pool) => pool.quota >= 8 && pool.quota <= 20), 'strategy pool quota should be bounded to 8-20')
}

{
  const adaptiveSpecs = [
    {
      id: 'adaptive_high_edge_v1',
      version: STRATEGY_SPEC_VERSION,
      name: 'Adaptive high edge',
      status: 'active' as const,
      owner: 'strategy' as const,
      familyId: 'TREND_RECLAIM_CONTINUATION' as const,
      variantId: 'adaptive_high_edge_v1',
      ownerType: 'strategy' as const,
      promotionStatus: 'production' as const,
      alphaBucket: 'trend_following' as const,
      supportedRegimes: ['bull' as const],
      thesis: 'High evidence strategy should receive a larger runtime budget.',
      thresholds: { minPrice: 10 },
      candidatePolicy: { poolQuota: 12, costBudget: 12, maxMlShare: 0.2 },
      riskNotes: ['test only'],
      createdBy: 'p5_strategy_governance' as const,
    },
    {
      id: 'adaptive_crowded_low_edge_v1',
      version: STRATEGY_SPEC_VERSION,
      name: 'Adaptive crowded low edge',
      status: 'active' as const,
      owner: 'strategy' as const,
      familyId: 'SMART_MONEY_ACCUMULATION' as const,
      variantId: 'adaptive_crowded_low_edge_v1',
      ownerType: 'strategy' as const,
      promotionStatus: 'production' as const,
      alphaBucket: 'defensive_accumulation' as const,
      supportedRegimes: ['bull' as const],
      thesis: 'Crowded weak evidence strategy should receive a smaller runtime budget.',
      thresholds: { minPrice: 10 },
      candidatePolicy: { poolQuota: 12, costBudget: 12, maxMlShare: 0.2 },
      riskNotes: ['test only'],
      createdBy: 'p5_strategy_governance' as const,
    },
  ]
  const pools = buildStrategyCandidatePools(candidates, adaptiveSpecs, {
    regime: 'bull',
    strategyPortfolioMetrics: {
      adaptive_high_edge_v1: {
        prior_weight: 1.55,
        reliability: 0.92,
        diversification_value: 0.88,
        crowding_score: 0.04,
        rank_ic: 0.16,
        recent_alpha: 0.08,
        strategy_metric_status: 'ready',
        metric_sources: ['immutable-test-artifact'],
        rolling_sharpe: 1.4,
        max_drawdown: 0.05,
      },
      adaptive_crowded_low_edge_v1: {
        prior_weight: 0.35,
        reliability: 0.24,
        diversification_value: 0.12,
        crowding_score: 0.91,
        rank_ic: -0.05,
        recent_alpha: -0.05,
        strategy_metric_status: 'ready',
        metric_sources: ['immutable-test-artifact'],
        rolling_sharpe: -0.4,
        max_drawdown: 0.32,
      },
    },
  })
  const high = pools.find((pool) => pool.strategy_id === 'adaptive_high_edge_v1') as any
  const low = pools.find((pool) => pool.strategy_id === 'adaptive_crowded_low_edge_v1') as any
  assert(high && low, 'adaptive policy test pools should be built')
  assert(high.static_quota === 12 && low.static_quota === 12, 'fixture must start from equal static poolQuota priors')
  assert(high.static_cost_budget === 12 && low.static_cost_budget === 12, 'fixture must start from equal static costBudget priors')
  assert(high.strict_match_count > high.quota, 'strict_match_count should remain raw breadth, not truncated by runtime quota')
  assert(high.quota > low.quota, 'adaptive poolQuota should reward reliable unique edge over crowded weak edge')
  assert(high.cost_budget > low.cost_budget, 'adaptive costBudget should follow marginal expected value evidence')
  assert(Number(high.max_ml_share) > Number(low.max_ml_share), 'adaptive maxMlShare should be a soft risk budget, not the static prior')
  assert(high.adaptive_policy.reason === 'adaptive_from_daily_breadth_portfolio_metrics_similarity_and_active_strategy_count', 'adaptive policy should expose its runtime reason')
}

{
  const legacyScoreV2Spec = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'legacy_score_v2_compat_test_v1',
    thresholds: { minSeedScore: 58, minTechScore: 18, minMomentumScore: 6, minPrice: 10 },
  }
  const scoreV2Only = {
    symbol: '2330',
    name: 'Score V2 Seed',
    industry: 'Semiconductor',
    score: 8,
    chip_score: 1,
    tech_score: 1,
    momentum_score: 1,
    current_price: 900,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
    score_components: JSON.stringify({
      version: 'score_v2',
      finalScore: 70,
      components: {
        mlEdge: 12,
        chipFlow: 24,
        technicalStructure: 22,
        fundamentalQuality: 10,
        newsTheme: 2,
      },
      technicalBreakdown: {
        trendStructure: 6,
        volatilityStructure: 4,
        reversalExtreme: 4,
        volumeConfirmation: 3,
        executionRisk: 1,
      },
      seedComponents: {
        screenerMomentumSeed20: 10,
      },
    }),
  }
  const pools = buildStrategyCandidatePools([scoreV2Only], [legacyScoreV2Spec], { regime: 'bull' })
  assert(pools[0].candidates.length === 1, 'candidate pool should rank by canonical Score V2 for legacy registry specs only')
  assert(pools[0].candidates[0].raw_score === 70, 'candidate pool raw score should expose canonical strategy seed score')
}

{
  const legacyScoreV2Spec = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'legacy_score_v2_total_compat_test_v1',
    thresholds: { minSeedScore: 58, minTechScore: 18, minMomentumScore: 6, minPrice: 10 },
  }
  const scoreV2TotalOnly = {
    symbol: '2454',
    name: 'Score V2 Total Seed',
    industry: 'Semiconductor',
    score: 8,
    chip_score: 1,
    tech_score: 1,
    momentum_score: 1,
    current_price: 900,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
    score_components: scoreV2Payload({
      chipFlow: 24,
      technicalStructure: 22,
      momentumScore: 10,
      mlEdge: 14,
      fundamentalQuality: 8,
      newsTheme: 2,
    }),
  }
  const pools = buildStrategyCandidatePools([scoreV2TotalOnly], [legacyScoreV2Spec], { regime: 'bull' })
  assert(pools[0].candidates.length === 1, 'legacy registry specs can still use Score V2 total when finalScore is absent')
  assert(pools[0].candidates[0].raw_score === 68, 'candidate pool must recompute canonical Score V2 total from weighted components instead of stale scalar score')
}

{
  const capacity = resolveStrategyCapacityBudget()
  assert(capacity.mode === 'base', 'default strategy budget should stay base')
  assert(capacity.totalCap === 64, 'base total budget should remain 64')
  const expanded = resolveStrategyCapacityBudget({ requestedMode: 'normal', observedPipelineMinutes: 9 })
  assert(expanded.mode === 'normal' && expanded.totalCap === 96, 'normal cap should require runtime telemetry')
  const blocked = resolveStrategyCapacityBudget({ requestedMode: 'low_load', observedPipelineMinutes: 12 })
  assert(blocked.mode === 'base' && blocked.totalCap === 64, 'low-load cap should not activate without good telemetry')
}

{
  const selection = planStrategyFirstCandidateSelection(candidates, DEFAULT_STRATEGY_SPECS, {
    regime: 'bull',
    mlQueueCapOverride: 24,
  })
  assert(selection.mlQueue.length <= 24, 'ML queue should obey caller cap')
  assert(selection.telemetry.deduped_symbols >= selection.mlQueue.length, 'merge should dedupe symbols before queueing')
  assert(selection.telemetry.estimated_batch_chunks === Math.ceil(selection.mlQueue.length / 40), 'batch chunk telemetry should match ML queue size')
  const maxPerStrategy = Math.floor(24 * DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY.maxOneStrategyShare)
  for (const count of Object.values(selection.telemetry.strategy_usage)) {
    assert(count <= maxPerStrategy, 'single strategy should not dominate the ML queue')
  }
}

{
  const nearMatchSpecs = [{
    id: 'near_match_spec_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Near match test',
    status: 'shadow' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Exercise adaptive near-match pool when strict thresholds are empty.',
    thresholds: { minCloseAboveMa20Pct: 0.025, minVolumeExpansion20: 1.38, minReturn20d: 0.03, minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }]
  const pools = buildStrategyCandidatePools(candidates.slice(0, 12), nearMatchSpecs, { regime: 'bull' })
  assert(pools[0].status === 'adaptive_near_match', 'empty strict pool should expose adaptive near-match status')
  assert(pools[0].daily_match_status === 'shadow_near_match', 'near-match pool should be explicitly separated from daily strict matches')
  assert(pools[0].strict_match_count === 0 && pools[0].near_match_count > 0, 'near-match pool should expose strict/near match counts')
  assert(pools[0].missing_evidence.includes('strict_threshold_match_empty'), 'adaptive near-match should be explicit evidence, not silent fallback')
  assert(
    pools[0].candidates[0]?.reason.startsWith('adaptive_near_match:'),
    'pool candidate reason should explain which thresholds were near misses',
  )
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 8 }))
  assert(selection.mlQueue.length === 0, 'adaptive near-match candidates must not enter formal production ML queue')
  assert(selection.researchOnlyQueue.length > 0, 'adaptive near-match candidates should remain visible as research-only evidence')
  const firstNearMatch = selection.researchOnlyQueue[0] as any
  assert(
    String(firstNearMatch.strategy_pool_reason || '').length > 0,
    'merged candidate should preserve a strategy pool reason',
  )
}

{
  const activeNoMatchSpec = {
    id: 'active_no_full_universe_spec_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active no full-universe fill test',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Active production strategies must not emit full-universe fill candidates when strict and near-match evidence is empty.',
    thresholds: { minCloseAboveMa20Pct: 0.4, minVolumeExpansion20: 3, minReturn20d: 0.5, minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const pools = buildStrategyCandidatePools(candidates.slice(0, 12), [activeNoMatchSpec], { regime: 'bull' })
  assert(pools[0].candidates.length === 0, 'active production strategies should not produce adaptive empty-pool garbage')
}

{
  const activeFormal137Spec = {
    id: 'active_formal137_feature_ref_no_near_match_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active formal137 feature ref strict test',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Active feature-ref strategies must fail closed when strict formal137 evidence is missing.',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 1.4,
      featureRefs: {
        weightedScore: {
          min: 0.58,
          terms: [
            { featureRef: 'us_sentiment_score', signal: 'factorSignals.us_sentiment_score', weight: 0.48 },
            { featureRef: 'margin_balance', signal: 'factorSignals.margin_balance', weight: 0.52 },
          ],
        },
      },
    },
    candidatePolicy: { poolQuota: 8, costBudget: 8, evidenceRequirements: ['formal137'] },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const nearMissWithoutFormalSentiment = {
    ...candidates[0],
    symbol: '9919',
    current_price: 30,
    raw_signals: {
      close: 30,
      volumeExpansion20: 1.2,
      marginBalance: 100,
      factorSignals: {
        us_sentiment_score: 1,
        margin_balance: 100,
        formal137MarginBalanceRank: 0.9,
      },
    },
  }
  const pools = buildStrategyCandidatePools([nearMissWithoutFormalSentiment], [activeFormal137Spec], { regime: 'bull' })
  assert(pools[0].status === 'ready', 'active formal137 strict-empty pool should not be labeled adaptive_near_match')
  assert(pools[0].daily_match_status === 'strict_empty_feature_ref', 'active formal137 strict-empty pool should expose daily strict feature-ref miss')
  assert(pools[0].strict_match_count === 0 && pools[0].near_match_count === 0, 'active formal137 strict-empty pool should not count near-match rows')
  assert(pools[0].candidates.length === 0, 'active formal137 feature-ref pool should fail closed instead of near-match filling')
  assert(
    pools[0].missing_evidence.includes('strict_feature_ref_match_empty'),
    'active formal137 strict-empty pool should expose feature-ref missing evidence',
  )
}

{
  const restricted = [
    { ...candidates[0], symbol: '9991', restricted: true, raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.08, volumeExpansion20: 1.5, return20d: 0.12 }) },
    { ...candidates[1], symbol: '9992', market_segment: 'EMERGING', eligible_for_ml: 0, raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.07, volumeExpansion20: 1.45, return20d: 0.1 }) },
    ...candidates.slice(2, 20),
  ]
  const pools = buildStrategyCandidatePools(restricted, DEFAULT_STRATEGY_SPECS, { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 10 }))
  const researchSymbols = new Set(selection.researchOnlyQueue.map((candidate) => candidate.symbol))
  assert(researchSymbols.has('9991') || researchSymbols.has('9992'), 'restricted or non-ML segment candidates should route to research-only queue')
}

{
  const retiredDiscovery = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'finlab_ai_skill_discovery_v1',
    status: 'retired' as const,
  }
  assert(!DEFAULT_STRATEGY_SPECS.some((spec) => spec.id === retiredDiscovery.id), 'FinLab AI Skill discovery spec must not remain in bootstrap defaults')
  const pools = buildStrategyCandidatePools(candidates.slice(0, 20), [retiredDiscovery], { regime: 'bull' })
  assert(pools.length === 0, 'retired FinLab AI Skill discovery lane must not create runtime strategy pools')
}

{
  const sharedCandidate = {
    ...candidates[0],
    symbol: '9988',
    raw_signals: rawSignalPayload({
      close: 52,
      closeAboveMa20Pct: 0.05,
      closeAboveMa60Pct: 0.03,
      volumeExpansion20: 1.4,
      return20d: 0.06,
    }),
  }
  const activeSpec = {
    id: 'active_shared_signal_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active shared signal',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Active strategy owns the production ML queue evidence.',
    thresholds: { minPrice: 10, minCloseAboveMa20Pct: 0, minVolumeExpansion20: 1.1 },
    candidatePolicy: { poolQuota: 8, costBudget: 8, maxMlShare: 0 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const researchSpec = {
    ...activeSpec,
    id: 'research_shared_signal_v1',
    name: 'Research shared signal',
    status: 'research' as const,
    thesis: 'Research matches must not be reported as production ML queue strategy ids.',
    candidatePolicy: { poolQuota: 8, costBudget: 8, maxMlShare: 0 },
  }
  const pools = buildStrategyCandidatePools([sharedCandidate], [researchSpec, activeSpec], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 4 }))
  const selected = selection.mlQueue.find((candidate) => candidate.symbol === '9988')
  assert(selected, 'shared active/research match should enter ML queue through the active strategy')
  assert(selected?.strategy_pool_ids?.includes('active_shared_signal_v1'), 'ML queue evidence should retain the active strategy id')
  assert(selected?.strategy_pool_reason !== 'strategy_not_active_production_owner', 'active production maxMlShare=0 must not be treated as research-only')
  assert(!selected?.strategy_pool_ids?.includes('research_shared_signal_v1'), 'ML queue evidence must not leak research strategy ids')
}

{
  const sharedCandidate = {
    ...candidates[0],
    symbol: '9977',
    raw_signals: rawSignalPayload({
      close: 52,
      closeAboveMa20Pct: 0.05,
      closeAboveMa60Pct: 0.03,
      volumeExpansion20: 1.4,
      return20d: 0.06,
      brokerCount: 8,
    }),
  }
  const trendA = {
    id: 'active_trend_a_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active trend A',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Trend family A.',
    thresholds: { minPrice: 10, minCloseAboveMa20Pct: 0, minVolumeExpansion20: 1.1 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const trendB = {
    ...trendA,
    id: 'active_trend_b_v1',
    name: 'Active trend B',
    thesis: 'Trend family B duplicate.',
  }
  const meanReversion = {
    ...trendA,
    id: 'active_mean_reversion_v1',
    name: 'Active mean reversion',
    alphaBucket: 'mean_reversion' as const,
    thesis: 'Different family can remain as a second active representative.',
  }
  const researchDuplicate = {
    ...trendA,
    id: 'research_trend_duplicate_v1',
    name: 'Research trend duplicate',
    status: 'research' as const,
    thesis: 'Research duplicate must stay attribution-only.',
    candidatePolicy: { poolQuota: 8, costBudget: 8, maxMlShare: 0 },
  }
  const pools = buildStrategyCandidatePools([sharedCandidate], [trendA, trendB, meanReversion, researchDuplicate], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 4 }))
  const selected = selection.mlQueue.find((candidate) => candidate.symbol === '9977') as any
  assert(selected, 'shared duplicate active families should still produce one ML queue candidate')
  const ids = selected.strategy_pool_ids ?? []
  assert(ids.length === 3, 'ML queue evidence should retain every active strategy hit while family ids remain deduped')
  assert(ids.filter((id: string) => id.startsWith('active_trend_')).length === 2, 'same-family active variants must remain visible for diversity attribution')
  assert(ids.includes('active_mean_reversion_v1'), 'different alpha bucket can remain as a separate representative')
  assert(!ids.includes('research_trend_duplicate_v1'), 'research duplicate must not leak into production strategy ids')
  assert((selected.strategy_family_ids ?? []).length === 2, 'family governance should stay deduped even when multiple variants match')
  assert((selected.strategy_variant_ids ?? []).includes('active_trend_a_v1'), 'variant evidence should include same-family variant A')
  assert((selected.strategy_variant_ids ?? []).includes('active_trend_b_v1'), 'variant evidence should include same-family variant B')
  assert((selected.research_strategy_ids ?? []).includes('research_trend_duplicate_v1'), 'research duplicate should remain visible as attribution')
}

{
  const plan = buildLayer1StrategyBreadthPlan(candidates.slice(0, 12), [], {
    targetSize: 4,
    coarseMlQueueSize: 2,
    regime: 'bull',
  })
  assert(plan.breadthPool.length === 0, 'empty strategy pools must not force-fill Layer1 breadth with raw signal observe names')
  assert((plan.telemetry as any).dynamic_effective_quota_total === 0, 'empty strategy pools should expose zero dynamic effective quota')
  assert((plan.telemetry as any).raw_signal_top_up_count === 0, 'raw signal top-up must not inflate final Layer1 count when active strategy evidence is zero')
  assert(plan.coarseQueue.length === 0, 'empty strategy pools must not fill formal L2 queue with raw-signal observe candidates')
}

{
  const modalCandidate = {
    ...candidates[0],
    symbol: '9966',
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: 0.05,
      volumeExpansion20: 1.5,
      return20d: 0.08,
    }),
  }
  const modalSpec = {
    id: 'active_modal_similarity_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active Modal similarity',
    status: 'active' as const,
    owner: 'strategy' as const,
    familyId: 'TREND_RECLAIM_CONTINUATION' as const,
    variantId: 'active_modal_similarity_v1',
    ownerType: 'strategy' as const,
    promotionStatus: 'production' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Modal/Python strategy similarity evidence should be injectable into L1.25.',
    thresholds: { minPrice: 10, minCloseAboveMa20Pct: 0.01, minVolumeExpansion20: 1.1 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const payload = buildStrategySimilarityEvidencePayload([modalCandidate], [modalSpec], { regime: 'bull' })
  assert(payload.strategies.length === 1, 'strategy similarity payload should be derived from L0/L1 labels, not a fixed strategy count')
  assert(payload.strategies[0].symbols.includes('9966'), 'strategy similarity payload must carry supported symbols into Modal')

  const injectedEvidence = coerceModalStrategySimilarityGraphEvidence({
    schema_version: 'strategy-similarity-evidence-v1',
    status: 'computed',
    version: 'strategy-similarity-graph-v1',
    source: 'modal_python',
    algorithm_owner: 'ml-service-modal-python',
    graph_algorithm: 'networkx.Graph+networkx.connected_components',
    method: 'networkx_connected_components_oof_residual_correlation',
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    eligible_oof_pair_count: 1,
    paired_date_max: 8,
    oof_max_date: '2026-07-08',
    medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
    evidence_only: true,
    global_k_hardcoded: false,
    production_selector: false,
    self_implemented_algorithm: false,
    kmedoids_pam_preflight_status: 'pass',
    kmedoids_pam_preflight: {
      status: 'pass',
      algorithm: 'sklearn_extra.cluster.KMedoids',
      method: 'pam',
      self_implemented_fallback: false,
    },
    strategy_count: 1,
    edge_count: 0,
    component_count: 1,
    effective_strategy_count: 1,
    edge_threshold: 1,
    edge_threshold_source: 'adaptive_empty',
    strategy_cluster_id: { active_modal_similarity_v1: 'sc000' },
    strategy_cluster_size: { active_modal_similarity_v1: 1 },
    strategy_cluster_crowding_score: { active_modal_similarity_v1: 0 },
    strategy_cluster_uniqueness_score: { active_modal_similarity_v1: 1 },
    medoid_strategy_by_cluster: { sc000: 'active_modal_similarity_v1' },
  })
  assert(injectedEvidence, 'Modal strategy similarity evidence should coerce to the router contract')
  const plan = buildLayer1StrategyBreadthPlan([modalCandidate], [modalSpec], {
    targetSize: 4,
    coarseMlQueueSize: 2,
    regime: 'bull',
    strategySimilarityGraphEvidence: injectedEvidence,
  })
  assert(plan.telemetry.strategy_similarity_evidence_source === 'modal_python', 'L1.25 must expose Modal/Python as the strategy similarity source')
  assert(plan.telemetry.strategy_similarity_algorithm_owner === 'ml-service-modal-python', 'L1.25 must not report Worker as the formal graph owner')
  assert(plan.telemetry.strategy_similarity_medoid_algorithm === "sklearn_extra.cluster.KMedoids(method='pam')", 'official PAM medoid evidence should be visible')
}

{
  const blockedEvidence = coerceModalStrategySimilarityGraphEvidence({
    schema_version: 'strategy-similarity-evidence-v1',
    status: 'blocked',
    version: 'strategy-similarity-graph-v1',
    source: 'modal_python',
    algorithm_owner: 'ml-service-modal-python',
    method: 'networkx_connected_components_oof_residual_correlation',
    input_scope: 'mature_oof_residual_returns_with_same_day_overlap_diagnostic',
    eligible_oof_pair_count: 1,
    paired_date_max: 8,
    oof_max_date: '2026-07-08',
    medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
    evidence_only: true,
    global_k_hardcoded: false,
    production_selector: false,
    self_implemented_algorithm: false,
    kmedoids_pam_preflight_status: 'blocked',
    kmedoids_pam_preflight: { status: 'blocked', self_implemented_fallback: false },
    strategy_count: 1,
    strategy_cluster_id: { blocked_strategy: 'sc000' },
  })
  assert(blockedEvidence === null, 'blocked official PAM preflight must not be accepted as formal Modal L1.25 evidence')
}
{
  const first: any = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'explicit_weight_owner_a',
    status: 'active',
    ownerType: 'strategy',
    promotionStatus: 'production',
    thresholds: { minPrice: 10 },
  }
  const omitted: any = {
    ...first,
    id: 'explicit_weight_owner_b',
    variantId: 'explicit_weight_owner_b',
  }
  const candidate: any = {
    symbol: '9912',
    current_price: 50,
    raw_signals: { close: 50 },
    score_v2: scoreV2Payload({ finalScore: 70, chipFlow: 18, technicalStructure: 18, momentumScore: 12 }),
  }
  const plan = buildMultiStrategyPleRoutingPlan([candidate], [first, omitted], {
    strategyWeights: { [first.id]: 1 },
    maxSlateSize: 1,
  })
  assert(plan.l0Annotated[0].strategy_pool_ids?.includes(first.id), 'explicit positive artifact weight must retain the production owner')
  assert(!plan.l0Annotated[0].strategy_pool_ids?.includes(omitted.id), 'strategy omitted from an explicit artifact weight map must have zero production contribution')
  const pools = buildStrategyCandidatePools([candidate], [first, omitted], {
    strategyWeights: { [first.id]: 1 },
  })
  assert(pools.find((pool) => pool.strategy_id === omitted.id)?.regime_weight === 0, 'candidate-pool evidence must use the same fail-closed explicit weight contract')
}
