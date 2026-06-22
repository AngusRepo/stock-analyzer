export interface ScreenerFunnelRow {
  symbol: string
  stage: string
  decision: string
  reason_code?: string | null
  score_before?: number | null
  score_after?: number | null
  rank?: number | null
  evidence?: unknown
}

export interface ScreenerFunnelStep {
  stage: string
  decision: string
  reason_code: string | null
  score_before: number | null
  score_after: number | null
  rank: number | null
  evidence: Record<string, unknown>
}

export interface ScreenerFunnelSummary {
  rank: number | null
  reason_code: string | null
  evidence: Record<string, unknown>
  timeline: ScreenerFunnelStep[]
}

export interface StrategyPortfolioIntelligenceHealth {
  schema_version: 'daily_strategy_portfolio_intelligence_health_v1'
  layer: 'L1.25'
  source: 'screener_funnel_items.layer125_finlab_portfolio_intelligence'
  method: 'finlab_style_strategy_as_asset_portfolio_metrics'
  decision_policy: 'strategy_asset_weighting_not_stock_selector'
  selection_policy: 'no_stock_shrink_no_topk_no_minimum_fill'
  output_scope: 'strategy_prior_family_prior_reliability_crowding_diversification'
  consumed_by: 'layer15_multi_strategy_ple_router'
  candidate_count: number
  evidence_count: number
  coverage_ratio: number
  portfolio_metric_status: string
  portfolio_metric_status_counts: Record<string, number>
  portfolio_metric_sources: string[]
  strategy_similarity_evidence_status_counts: Record<string, number>
  strategy_similarity_sources: string[]
  strategy_similarity_algorithm_owners: string[]
  strategy_similarity_medoid_algorithms: string[]
  strategy_similarity_blocked_count: number
  /** @deprecated Historical rows before blocked_reason was introduced. */
  strategy_similarity_degraded_count: number
  metric_count_max: number | null
  metric_count_sum: number
  backtest_metric_count_max: number | null
  backtest_result_row_count_max: number | null
  layer125_evidence_available: boolean
  used_live_strategy_asset_metrics: boolean
  degraded_reason: string | null
  no_stock_selection: true
  no_topk: true
}

const L2_COARSE_MODELS = ['LightGBM', 'XGBoost', 'ExtraTrees'] as const
const L3_FORMAL_MODELS = ['TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer', 'TimesFM'] as const
const ACTIVE_9_ML_TEACHER_MODELS = [...L2_COARSE_MODELS, ...L3_FORMAL_MODELS] as const

function parseEvidence(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toNullableNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function pickLastByStage(steps: ScreenerFunnelStep[], stage: string): ScreenerFunnelStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].stage === stage) return steps[i]
  }
  return null
}

function pickAllByStage(steps: ScreenerFunnelStep[], stage: string): ScreenerFunnelStep[] {
  return steps.filter((step) => step.stage === stage)
}

function pickLastFormalLayer2Step(steps: ScreenerFunnelStep[]): ScreenerFunnelStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.stage !== 'layer2_coarse_ml_gate') continue
    if (step.decision !== 'pass') continue
    if (step.evidence?.worker_seed_only === true) continue
    return step
  }
  return null
}

function normalizeScore01(value: unknown): number | null {
  const n = toNullableNumber(value)
  if (n == null) return null
  if (Math.abs(n) <= 1) return Math.max(0, Math.min(1, n))
  return Math.max(0, Math.min(1, n / 100))
}

function buildLayer35EvidenceFusion(
  layer1: ScreenerFunnelStep | null,
  layer3: ScreenerFunnelStep | null,
): Record<string, unknown> | null {
  if (!layer1 && !layer3) return null
  const routeScore = normalizeScore01(layer1?.evidence?.candidate_route_score ?? layer1?.evidence?.strategy_router_score)
  const formalFamilyScore = normalizeScore01(layer3?.score_after ?? layer3?.evidence?.family_score)
  const activeFamilyCount = toNullableNumber(layer3?.evidence?.active_family_count)
  const contributingModels = Array.isArray(layer3?.evidence?.contributing_models)
    ? layer3?.evidence?.contributing_models.map(String).filter(Boolean)
    : []
  const uncertainty = normalizeScore01(layer1?.evidence?.uncertainty)
  const scoreGap = routeScore != null && formalFamilyScore != null
    ? Math.round(Math.abs(routeScore - formalFamilyScore) * 10000) / 10000
    : null
  const conflictLevel = scoreGap == null
    ? 'insufficient_evidence'
    : scoreGap >= 0.35 || (uncertainty != null && uncertainty >= 0.7) || (activeFamilyCount != null && activeFamilyCount < 2)
      ? 'high'
      : scoreGap >= 0.18 || (uncertainty != null && uncertainty >= 0.55)
        ? 'medium'
        : 'low'
  const decision = conflictLevel === 'high'
    ? 'conflicted'
    : conflictLevel === 'insufficient_evidence'
      ? 'insufficient_evidence'
      : 'supportive'
  const recommendedAction = conflictLevel === 'high'
    ? 'flag_conflict_for_l4_sparse_without_hard_drop'
    : conflictLevel === 'medium'
      ? 'calibrate_weight_do_not_drop'
      : conflictLevel === 'low'
        ? 'allow_downstream_sparse_allocation'
        : 'observe_until_l1_l3_evidence_available'
  return {
    schema_version: 'layer35_evidence_fusion_v1',
    source: 'screener_funnel_items',
    owner: 'worker_evidence_fusion',
    fusion_method: 'strategy_router_vs_9ml_formal_family_evidence_calibration',
    input_scope: 'layer15_route_score_layer3_formal_family_score_uncertainty_active_family_count',
    decision_policy: 'observe_only_no_hard_shrink',
    selection_policy: 'no_candidate_drop_no_topk_no_minimum_fill',
    hard_shrink_allowed: false,
    is_final_allocator: false,
    final_allocation_owner: 'layer4_sparse_allocation',
    output_scope: 'conflict_level_strategy_ml_score_gap_supportive_or_conflicted_evidence',
    conflict_thresholds: {
      high_score_gap: 0.35,
      medium_score_gap: 0.18,
      high_uncertainty: 0.7,
      medium_uncertainty: 0.55,
      min_active_family_count: 2,
    },
    route_evidence_available: routeScore != null,
    formal_ml_evidence_available: formalFamilyScore != null,
    active_l3_family_sufficient: activeFamilyCount == null ? null : activeFamilyCount >= 2,
    layer1_route_score: routeScore,
    layer1_uncertainty: uncertainty,
    layer3_formal_family_score: formalFamilyScore,
    active_family_count: activeFamilyCount,
    contributing_model_count: contributingModels.length,
    contributing_models: contributingModels,
    strategy_ml_score_gap: scoreGap,
    conflict_level: conflictLevel,
    decision,
    recommended_action: recommendedAction,
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function hasRecord(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length)
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = String(key ?? '').trim()
    const n = toNullableNumber(raw)
    if (cleanKey && n != null) out[cleanKey] = n
  }
  return out
}

function averageNumbers(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value))
  if (!clean.length) return null
  return Math.round((clean.reduce((sum, value) => sum + value, 0) / clean.length) * 1000) / 1000
}

function maxNumber(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value))
  return clean.length ? Math.max(...clean) : null
}

function sumNumbers(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value))
  if (!clean.length) return null
  return Math.round(clean.reduce((sum, value) => sum + value, 0) * 1000) / 1000
}

function unionStrings(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map(String).map((value) => value.trim()).filter(Boolean))]
}

function buildLayer1StrategyLabelerSummary(
  layer1: ScreenerFunnelStep | null,
  candidateSeed: ScreenerFunnelStep | null,
): Record<string, unknown> | null {
  const source = layer1 ?? candidateSeed
  if (!source) return null
  const evidence = source.evidence ?? {}
  const strategyAffinity = numberRecord(evidence.strategy_affinity_vector)
  const weakLabels = numberRecord(evidence.strategy_weak_label_vector)
  const strategyHits = numberRecord(evidence.strategy_hit_vector)
  const positionWeights = numberRecord(evidence.strategy_position_weight_vector)
  const overlap = numberRecord(evidence.strategy_overlap_vector)
  const familyAffinity = numberRecord(evidence.strategy_family_affinity ?? evidence.family_affinity)
  const vectorStrategyIds = unionStrings(
    Object.keys(strategyAffinity),
    Object.keys(weakLabels),
    Object.keys(strategyHits),
    Object.keys(positionWeights),
    Object.keys(overlap),
  )
  const activeStrategyIds = arrayOfStrings(evidence.strategy_ids ?? evidence.strategy_pool_ids)
  const researchStrategyIds = arrayOfStrings(evidence.research_strategy_ids)
  const familyIds = unionStrings(arrayOfStrings(evidence.strategy_family_ids), Object.keys(familyAffinity))
  const allStrategyIds = unionStrings(activeStrategyIds, researchStrategyIds, vectorStrategyIds)
  const matrixStrategyCount = toNullableNumber(evidence.strategy_matrix_strategy_count)
  const matrixCandidateCount = toNullableNumber(evidence.strategy_matrix_candidate_count ?? evidence.source_universe_count)
  const matrixCellCount = toNullableNumber(evidence.strategy_matrix_cell_count)
  const matrixExpectedCellCount = toNullableNumber(evidence.strategy_matrix_expected_cell_count)
  const hasLabelEvidence = Boolean(
    evidence.strategy_labeler_version
    || matrixStrategyCount != null
    || matrixCellCount != null
    || allStrategyIds.length
    || familyIds.length
    || hasRecord(evidence.strategy_affinity_vector)
    || hasRecord(evidence.strategy_weak_label_vector)
    || hasRecord(evidence.strategy_hit_vector)
    || hasRecord(evidence.strategy_position_weight_vector)
    || hasRecord(evidence.strategy_overlap_vector)
    || hasRecord(evidence.strategy_family_affinity ?? evidence.family_affinity),
  )
  if (!hasLabelEvidence) return null

  return {
    schema_version: 'layer1_strategy_labeler_summary_v1',
    source: 'screener_funnel_items',
    owner: 'worker_strategy_labeler',
    decision_policy: 'label_all_candidates_not_selector',
    selection_policy: 'no_topk_no_shrink_no_minimum_fill',
    label_scope: 'strategy_affinity_family_affinity_weak_labels',
    matrix_contract: 'runtime_l0_universe_count_by_current_strategy_count',
    matrix_policy: 'complete_strategy_dimension_with_zero_for_non_hits',
    next_layer_owner: 'layer15_multi_strategy_ple_router',
    strategy_labeler_version: evidence.strategy_labeler_version ?? null,
    source_universe_count: toNullableNumber(evidence.source_universe_count),
    decision: source.decision,
    reason_code: source.reason_code,
    rank: source.rank,
    score_after: toNullableNumber(source.score_after),
    strategy_count: matrixStrategyCount ?? allStrategyIds.length,
    active_strategy_count: activeStrategyIds.length,
    research_strategy_count: researchStrategyIds.length,
    family_count: familyIds.length,
    vector_strategy_count: vectorStrategyIds.length,
    strategy_matrix_candidate_count: matrixCandidateCount,
    strategy_matrix_strategy_count: matrixStrategyCount,
    strategy_matrix_cell_count: matrixCellCount,
    strategy_matrix_expected_cell_count: matrixExpectedCellCount,
    strategy_matrix_coverage_ratio: normalizeScore01(evidence.strategy_matrix_coverage_ratio),
    strategy_matrix_matched_candidate_count: toNullableNumber(evidence.strategy_matrix_matched_candidate_count),
    strategy_matrix_active_labeled_candidate_count: toNullableNumber(evidence.strategy_matrix_active_labeled_candidate_count),
    strategy_ids: activeStrategyIds,
    research_strategy_ids: researchStrategyIds,
    family_ids: familyIds,
    vector_strategy_ids: vectorStrategyIds,
    has_strategy_affinity_vector: Object.keys(strategyAffinity).length > 0,
    has_family_affinity_vector: Object.keys(familyAffinity).length > 0,
    has_weak_label_vector: Object.keys(weakLabels).length > 0,
    has_hit_vector: Object.keys(strategyHits).length > 0,
    has_position_weight_vector: Object.keys(positionWeights).length > 0,
    has_overlap_vector: Object.keys(overlap).length > 0,
    max_strategy_affinity: maxNumber(Object.values(strategyAffinity)),
    avg_strategy_affinity: averageNumbers(Object.values(strategyAffinity)),
    strategy_hit_count: Object.values(strategyHits).filter((value) => value > 0).length,
    position_weight_sum: sumNumbers(Object.values(positionWeights)),
    max_strategy_overlap: maxNumber(Object.values(overlap)),
  }
}

function buildLayer125FinLabPortfolioIntelligenceSummary(
  layer1: ScreenerFunnelStep | null,
  candidateSeed: ScreenerFunnelStep | null,
): Record<string, unknown> | null {
  const source = layer1 ?? candidateSeed
  if (!source) return null
  const evidence = source.evidence ?? {}
  const components = evidence.strategy_router_components && typeof evidence.strategy_router_components === 'object'
    ? evidence.strategy_router_components as Record<string, unknown>
    : {}
  const strategyPriorWeight = toNullableNumber(components.strategy_prior_weight)
  const familyPriorWeight = toNullableNumber(components.family_prior_weight)
  const reliability = normalizeScore01(components.strategy_reliability)
  const crowding = normalizeScore01(components.strategy_crowding_score)
  const diversification = normalizeScore01(components.strategy_diversification_value)
  const overlap = numberRecord(evidence.strategy_overlap_vector)
  const activeStrategyIds = arrayOfStrings(evidence.strategy_ids ?? evidence.strategy_pool_ids)
  const familyIds = arrayOfStrings(evidence.strategy_family_ids)
  const metricCount = toNullableNumber(evidence.strategy_portfolio_metric_count)
  const matrixStrategyCount = toNullableNumber(evidence.strategy_matrix_strategy_count)
  const backtestMetricCount = toNullableNumber(evidence.strategy_portfolio_backtest_metric_count)
  const backtestResultRowCount = toNullableNumber(evidence.strategy_portfolio_backtest_result_row_count)
  const strategySimilarityEvidenceStatus = String(evidence.strategy_similarity_evidence_status ?? '').trim() || null
  const strategySimilarityEvidenceSource = String(evidence.strategy_similarity_evidence_source ?? '').trim() || null
  const strategySimilarityAlgorithmOwner = String(evidence.strategy_similarity_algorithm_owner ?? '').trim() || null
  const strategySimilarityMedoidAlgorithm = String(evidence.strategy_similarity_medoid_algorithm ?? '').trim() || null
  const strategySimilarityBlockedReason = String(
    evidence.strategy_similarity_blocked_reason ?? evidence.strategy_similarity_degraded_reason ?? '',
  ).trim() || null
  const hasPortfolioEvidence = Boolean(
    evidence.finlab_portfolio_intelligence_version
    || evidence.strategy_portfolio_metric_source
    || evidence.strategy_portfolio_metric_status
    || strategySimilarityEvidenceStatus
    || strategySimilarityEvidenceSource
    || strategySimilarityAlgorithmOwner
    || strategySimilarityMedoidAlgorithm
    || metricCount != null
    || backtestMetricCount != null
    || strategyPriorWeight != null
    || familyPriorWeight != null
    || reliability != null
    || crowding != null
    || diversification != null
  )
  if (!hasPortfolioEvidence) return null

  return {
    schema_version: 'layer125_finlab_portfolio_intelligence_summary_v1',
    source: 'screener_funnel_items',
    owner: 'worker_strategy_portfolio_intelligence',
    method: 'finlab_style_strategy_as_asset_portfolio_metrics',
    decision_policy: 'strategy_asset_weighting_not_stock_selector',
    selection_policy: 'no_stock_shrink_no_topk_no_minimum_fill',
    output_scope: 'strategy_prior_family_prior_reliability_crowding_diversification',
    consumed_by: 'layer15_multi_strategy_ple_router',
    finlab_portfolio_intelligence_version: evidence.finlab_portfolio_intelligence_version ?? null,
    portfolio_metric_source: evidence.strategy_portfolio_metric_source ?? null,
    portfolio_metric_status: evidence.strategy_portfolio_metric_status ?? null,
    portfolio_metric_count: metricCount,
    backtest_metric_count: backtestMetricCount,
    backtest_result_row_count: backtestResultRowCount,
    strategy_similarity_evidence_status: strategySimilarityEvidenceStatus,
    strategy_similarity_evidence_source: strategySimilarityEvidenceSource,
    strategy_similarity_algorithm_owner: strategySimilarityAlgorithmOwner,
    strategy_similarity_medoid_algorithm: strategySimilarityMedoidAlgorithm,
    strategy_similarity_blocked_reason: strategySimilarityBlockedReason,
    strategy_similarity_scope: 'strategy_supported_symbols_graph_evidence_not_stock_selector',
    strategy_count: matrixStrategyCount ?? metricCount ?? activeStrategyIds.length,
    strategy_metric_count: metricCount,
    strategy_matrix_strategy_count: matrixStrategyCount,
    family_count: familyIds.length,
    strategy_ids: activeStrategyIds,
    family_ids: familyIds,
    strategy_prior_weight: strategyPriorWeight,
    family_prior_weight: familyPriorWeight,
    strategy_reliability: reliability,
    strategy_crowding_score: crowding,
    strategy_diversification_value: diversification,
    max_holding_overlap: maxNumber(Object.values(overlap)),
    metric_dimensions: [
      'rolling_sharpe',
      'max_drawdown',
      'recent_alpha',
      'return_correlation',
      'holding_overlap',
      'turnover',
      'factor_return',
      'factor_crowding',
      'centrality',
      'ic',
      'rank_ic',
      'shapley_contribution',
      'regime_performance',
      'live_backtest_divergence',
    ],
    crowding_action: crowding == null
      ? 'crowding_unknown'
      : crowding >= 0.6
        ? 'down_weight_crowded_strategy_support'
        : 'allow_strategy_support',
    reliability_action: reliability == null
      ? 'reliability_unknown'
      : reliability >= 0.6
        ? 'increase_prior_weight'
        : 'down_weight_unreliable_strategy_support',
  }
}

function buildLayer0UniverseFeaturesSummary(
  universe: ScreenerFunnelStep | null,
  scoring: ScreenerFunnelStep | null,
  layer1: ScreenerFunnelStep | null,
  candidateSeed: ScreenerFunnelStep | null,
): Record<string, unknown> | null {
  if (!universe && !scoring) return null
  const universeEvidence = universe?.evidence ?? {}
  const scoringEvidence = scoring?.evidence ?? {}
  const featureGroups = [
    universe && (
      universeEvidence.close != null
      || universeEvidence.avgVol20 != null
      || universeEvidence.avgDailyTurnover != null
    ) ? 'price_volume_liquidity' : null,
    scoringEvidence.score_components != null ? 'score_v2_components' : null,
    hasRecord(scoringEvidence.raw_signals) ? 'strategy_raw_signals' : null,
    hasRecord(scoringEvidence.taxonomy) ? 'finlab_taxonomy_profile' : null,
  ].filter((value): value is string => Boolean(value))

  return {
    schema_version: 'layer0_universe_features_summary_v1',
    source: 'screener_funnel_items',
    decision_policy: 'feature_materialization_only_not_selector',
    selection_policy: 'no_topk_no_shrink',
    universe_decision: universe?.decision ?? null,
    universe_reason: universe?.reason_code ?? null,
    universe_passed: universe?.decision === 'pass',
    base_score: toNullableNumber(scoring?.score_after),
    scoring_reason: scoring?.reason_code ?? null,
    source_universe_count: toNullableNumber(layer1?.evidence?.source_universe_count ?? candidateSeed?.evidence?.source_universe_count),
    feature_group_count: featureGroups.length,
    feature_groups: featureGroups,
    has_score_v2_components: scoringEvidence.score_components != null,
    has_strategy_raw_signals: hasRecord(scoringEvidence.raw_signals),
    has_taxonomy_profile: hasRecord(scoringEvidence.taxonomy),
    close: toNullableNumber(universeEvidence.close),
    avg_volume_20d: toNullableNumber(universeEvidence.avgVol20),
    avg_daily_turnover: toNullableNumber(universeEvidence.avgDailyTurnover),
  }
}

function buildLayer2CoarseMlSummary(
  layer2: ScreenerFunnelStep | null,
  layer2Seed: ScreenerFunnelStep | null,
): Record<string, unknown> | null {
  const source = layer2 ?? layer2Seed
  if (!source) return null
  const evidence = source.evidence ?? {}
  const workerSeedOnly = evidence.worker_seed_only === true
  const formalPass = Boolean(layer2 && layer2.decision === 'pass' && !workerSeedOnly)
  return {
    schema_version: 'layer2_3ml_coarse_summary_v1',
    source: 'screener_funnel_items',
    owner: 'ml_controller',
    model_scope: 'l2_3ml_coarse',
    expected_models: [...L2_COARSE_MODELS],
    expected_model_count: L2_COARSE_MODELS.length,
    decision_policy: 'three_ml_coarse_screen_not_final_ranker',
    model_family_deweight_policy: 'tree_family_correlation_cap_l2_coarse',
    correlation_cap_policy: 'l2_model_family_correlation_cap',
    diversity_loss_report_scope: 'l1_to_l2_strategy_family_retention',
    capacity_policy: 'max_only_no_minimum_no_topup',
    formal_l2_queue: evidence.formal_l2_queue === true || formalPass,
    formal_l2_pass: formalPass,
    worker_seed_only: workerSeedOnly,
    decision: formalPass ? source.decision : 'queue_seed_observe',
    reason_code: source.reason_code,
    rank: source.rank,
    score_after: toNullableNumber(source.score_after),
    coarse_queue_size: toNullableNumber(evidence.coarse_ml_queue_size ?? evidence.coarse_ml_queue_size_legacy),
    coarse_keep_ratio: toNullableNumber(evidence.coarse_ml_keep_ratio),
    core_ml_shortlist_size: toNullableNumber(evidence.core_ml_shortlist_size),
  }
}

function buildLayer3FormalMlSummary(layer3: ScreenerFunnelStep | null): Record<string, unknown> | null {
  if (!layer3) return null
  const evidence = layer3.evidence ?? {}
  const contributingModels = arrayOfStrings(evidence.contributing_models)
  const activeFamilies = arrayOfStrings(evidence.active_families)
  const l2ModelSet = new Set<string>(L2_COARSE_MODELS)
  const l3ModelSet = new Set<string>(L3_FORMAL_MODELS)
  const l2ContributingModels = contributingModels.filter((model) => l2ModelSet.has(model))
  const l3ContributingModels = contributingModels.filter((model) => l3ModelSet.has(model))
  return {
    schema_version: 'layer3_6ml_formal_summary_v1',
    source: 'screener_funnel_items',
    owner: 'ml_controller',
    model_scope: 'l3_6ml_formal',
    expected_models: [...L3_FORMAL_MODELS],
    expected_model_count: L3_FORMAL_MODELS.length,
    decision_policy: 'six_ml_formal_family_vote_not_topk',
    retention_report_schema: 'strategy_family_retention_report_v1',
    retention_input_layer: 'layer2_3ml_coarse',
    retention_output_layer: 'layer3_6ml_formal',
    diversity_loss_report_scope: 'l2_to_l3_model_family_retention',
    capacity_policy: 'evidence_only_no_minimum_fill',
    decision: layer3.decision,
    reason_code: layer3.reason_code,
    rank: layer3.rank,
    formal_family_score: normalizeScore01(layer3.score_after ?? evidence.family_score),
    active_family_count: toNullableNumber(evidence.active_family_count),
    active_families: activeFamilies,
    contributing_model_count: contributingModels.length,
    contributing_models: contributingModels,
    l2_contributing_models: l2ContributingModels,
    l3_contributing_models: l3ContributingModels,
    active_l3_model_count: l3ContributingModels.length,
    weights: evidence.weights ?? null,
  }
}

function buildLayer15MultiStrategyRouterSummary(
  layer1: ScreenerFunnelStep | null,
  candidateSeed: ScreenerFunnelStep | null,
): Record<string, unknown> | null {
  const source = layer1 ?? candidateSeed
  if (!source) return null
  const evidence = source.evidence ?? {}
  const routeScore = normalizeScore01(evidence.candidate_route_score ?? evidence.strategy_router_score)
  const eligibility = normalizeScore01(evidence.ml_slate_eligibility)
  const strategyIds = arrayOfStrings(evidence.strategy_ids ?? evidence.strategy_pool_ids)
  const familyIds = arrayOfStrings(evidence.strategy_family_ids)
  const researchStrategyIds = arrayOfStrings(evidence.research_strategy_ids)
  const teacherLabels = numberRecord(evidence.runtime_teacher_evidence ?? evidence.ml_teacher_labels ?? evidence.model_teacher_labels)
  const teacherModelIds = unionStrings(Object.keys(teacherLabels))
  const formalL2Queue = evidence.formal_l2_queue === true
    || evidence.strategy_router_decision === 'ml_slate'
    || evidence.strategy_pool_decision === 'ml_queue'
    || source.stage === 'strategy_pool_ml_queue'
      ? true
      : evidence.formal_l2_queue === false
        || evidence.strategy_pool_fallback_source === 'raw_signal_top_up'
        || evidence.strategy_pool_decision === 'research_only_queue'
          ? false
          : null
  const observeOnlyTopUp = evidence.strategy_pool_fallback_source === 'raw_signal_top_up'
    || String(evidence.strategy_pool_reason ?? evidence.strategy_router_reason ?? source.reason_code ?? '').includes('top_up_observe')
  const components = evidence.strategy_router_components && typeof evidence.strategy_router_components === 'object'
    ? evidence.strategy_router_components as Record<string, unknown>
    : {}
  const slateSelectionPolicy = evidence.l15_router_slate_selection_policy
    ?? evidence.slate_selection_policy
    ?? null
  const hasRouterEvidence = evidence.strategy_router_version
    || routeScore != null
    || eligibility != null
    || strategyIds.length
    || familyIds.length
  if (!hasRouterEvidence) return null

  return {
    schema_version: 'layer15_multi_strategy_router_summary_v1',
    source: 'screener_funnel_items',
    owner: 'worker_multi_strategy_ple_router',
    router_method: 'multi_strategy_ple_listwise_distillation_router',
    router_scope: 'full_candidate_slate_to_diversified_ml_slate',
    decision_policy: 'diversified_ml_slate_not_topk',
    selection_policy: 'quality_floor_max_capacity_no_forced_fill',
    slate_selection_policy: slateSelectionPolicy,
    adaptive_slate_builder: slateSelectionPolicy,
    self_learning_loop: 'strategy_decision_log_to_strategy_reward_ledger_to_strategy_portfolio_metrics_to_l15_marginal_utility',
    reward_feedback_source: evidence.strategy_portfolio_metric_source ?? null,
    capacity_policy: 'max_only_no_minimum_no_topup',
    no_topup_policy_scope: 'formal_ml_slate_no_minimum_fill',
    observe_topup_policy: 'research_observe_only_never_formal_l2',
    no_minimum_fill: true,
    is_topk_ranker: false,
    output_scope: 'candidate_route_score_ml_slate_eligibility_family_exposure_diversity_risk_uncertainty',
    teacher_label_scope: 'training_teacher_labels_offline_runtime_teacher_evidence_optional',
    runtime_teacher_evidence_policy: evidence.runtime_teacher_evidence_policy
      ?? 'previous_trading_day_or_latest_verified_cache_no_same_day_l2_l3_dependency',
    runtime_teacher_evidence_source: evidence.runtime_teacher_evidence_source ?? null,
    expected_teacher_models: [...ACTIVE_9_ML_TEACHER_MODELS],
    expected_teacher_count: ACTIVE_9_ML_TEACHER_MODELS.length,
    teacher_models: teacherModelIds,
    teacher_label_count: teacherModelIds.length,
    formal_l2_queue: formalL2Queue,
    observe_only_top_up: observeOnlyTopUp,
    strategy_labeler_version: evidence.strategy_labeler_version ?? null,
    strategy_router_version: evidence.strategy_router_version ?? null,
    strategy_router_decision: evidence.strategy_router_decision ?? evidence.strategy_pool_decision ?? source.decision,
    strategy_router_reason: evidence.strategy_router_reason ?? evidence.strategy_pool_reason ?? source.reason_code,
    route_score: routeScore,
    ml_slate_eligibility: eligibility,
    strategy_count: strategyIds.length,
    family_count: familyIds.length,
    research_strategy_count: researchStrategyIds.length,
    strategy_ids: strategyIds,
    family_ids: familyIds,
    research_strategy_ids: researchStrategyIds,
    family_exposure: evidence.family_exposure ?? null,
    diversity_contribution: normalizeScore01(evidence.diversity_contribution),
    risk_adjusted_affinity: normalizeScore01(evidence.risk_adjusted_affinity),
    uncertainty: normalizeScore01(evidence.uncertainty),
    strategy_prior_weight: toNullableNumber(components.strategy_prior_weight),
    family_prior_weight: toNullableNumber(components.family_prior_weight),
    strategy_reliability: normalizeScore01(components.strategy_reliability),
    strategy_crowding_score: normalizeScore01(components.strategy_crowding_score),
    strategy_diversification_value: normalizeScore01(components.strategy_diversification_value),
    marginal_utility_score: toNullableNumber(components.marginal_utility_score),
    marginal_selection_step: toNullableNumber(components.marginal_selection_step),
    learned_strategy_edge: toNullableNumber(components.learned_strategy_edge),
    strategy_uniqueness_bonus: toNullableNumber(components.strategy_uniqueness_bonus),
    family_diversification_bonus: toNullableNumber(components.family_diversification_bonus),
    exploration_bonus: toNullableNumber(components.exploration_bonus),
    overlap_penalty: toNullableNumber(components.overlap_penalty),
    crowding_penalty: toNullableNumber(components.crowding_penalty),
    new_strategy_ratio: normalizeScore01(components.new_strategy_ratio),
    new_family_ratio: normalizeScore01(components.new_family_ratio),
    strategy_rank_ic: toNullableNumber(components.strategy_rank_ic),
    strategy_cluster_uniqueness: normalizeScore01(components.strategy_cluster_uniqueness),
    teacher_alignment: normalizeScore01(components.teacher_alignment),
    portfolio_metric_source: evidence.strategy_portfolio_metric_source ?? null,
    portfolio_metric_status: evidence.strategy_portfolio_metric_status ?? null,
    portfolio_metric_count: toNullableNumber(evidence.strategy_portfolio_metric_count),
    backtest_metric_count: toNullableNumber(evidence.strategy_portfolio_backtest_metric_count),
    backtest_result_row_count: toNullableNumber(evidence.strategy_portfolio_backtest_result_row_count),
  }
}

function pickCandidateSeedStep(steps: ScreenerFunnelStep[]): ScreenerFunnelStep | null {
  return pickLastByStage(steps, 'l1_candidate_seed_after_overlay') ?? pickLastByStage(steps, 'final_selection')
}

function summarizeEvidence(steps: ScreenerFunnelStep[]): Record<string, unknown> {
  const finalSelection = pickLastByStage(steps, 'final_selection')
  const candidateSeed = pickCandidateSeedStep(steps)
  const layer1 = pickLastByStage(steps, 'layer1_strategy_breadth_gate')
  const layer2 = pickLastFormalLayer2Step(steps)
  const layer15SlateSeed = pickLastByStage(steps, 'l15_ml_slate_queue')
  const legacyLayer2Seed = pickLastByStage(steps, 'layer2_coarse_ml_gate')
  const layer2Seed = layer15SlateSeed ?? legacyLayer2Seed
  const layer3 = pickLastByStage(steps, 'layer3_formal_ml_gate')
  const universe = pickLastByStage(steps, 'universe')
  const layer2Summary = buildLayer2CoarseMlSummary(layer2, layer2Seed)
  const layer3Summary = buildLayer3FormalMlSummary(layer3)
  const layer1Labeler = buildLayer1StrategyLabelerSummary(layer1, candidateSeed)
  const layer125 = buildLayer125FinLabPortfolioIntelligenceSummary(layer1, candidateSeed)
  const layer15 = buildLayer15MultiStrategyRouterSummary(layer1, candidateSeed)
  const layer35 = buildLayer35EvidenceFusion(layer1, layer3)
  const rrg = pickLastByStage(steps, 'rrg_overlay')
  const buzz = pickLastByStage(steps, 'buzz_evidence')
  const strategyPool = [
    ...pickAllByStage(steps, 'strategy_pool_ml_queue'),
    ...pickAllByStage(steps, 'strategy_pool_research_only'),
  ]
  const diversity = pickAllByStage(steps, 'diversity_cooldown')
  const scoring = pickLastByStage(steps, 'scoring')
  const layer0 = buildLayer0UniverseFeaturesSummary(universe, scoring, layer1, candidateSeed)

  const evidence: Record<string, unknown> = {
    ...(candidateSeed?.evidence ?? {}),
    source_of_truth: 'screener_funnel_items',
    decision_path: steps.map((step) => ({
      stage: step.stage,
      decision: step.decision,
      reason_code: step.reason_code,
      score_before: step.score_before,
      score_after: step.score_after,
      rank: step.rank,
    })),
  }

  if (layer0) evidence.layer0_universe_features = layer0
  if (scoring) evidence.base_scoring = scoring.evidence
  if (layer1) evidence.layer1_breadth = { reason_code: layer1.reason_code, rank: layer1.rank, score_after: layer1.score_after, ...layer1.evidence }
  if (layer1Labeler) evidence.layer1_strategy_labeler = layer1Labeler
  if (layer125) evidence.layer125_finlab_portfolio_intelligence = layer125
  if (layer15) evidence.layer15_multi_strategy_router = layer15
  if (layer2Summary) evidence.layer2_3ml_coarse = layer2Summary
  if (layer2) evidence.layer2_coarse_ml = { reason_code: layer2.reason_code, rank: layer2.rank, score_after: layer2.score_after, ...layer2.evidence }
  if (layer15SlateSeed) evidence.layer15_ml_slate_queue = { reason_code: layer15SlateSeed.reason_code, rank: layer15SlateSeed.rank, score_after: layer15SlateSeed.score_after, ...layer15SlateSeed.evidence }
  if (!layer2 && layer2Seed) evidence.layer2_queue_seed = { reason_code: layer2Seed.reason_code, rank: layer2Seed.rank, score_after: layer2Seed.score_after, ...layer2Seed.evidence }
  if (layer3Summary) evidence.layer3_6ml_formal = layer3Summary
  if (layer3) evidence.layer3_formal_ml = { reason_code: layer3.reason_code, rank: layer3.rank, score_after: layer3.score_after, ...layer3.evidence }
  if (layer35) evidence.layer35_evidence_fusion = layer35
  if (rrg) evidence.rrg_overlay = { reason_code: rrg.reason_code, ...rrg.evidence }
  if (buzz) evidence.buzz_evidence = { reason_code: buzz.reason_code, ...buzz.evidence }
  if (strategyPool.length) {
    evidence.strategy_pool = strategyPool.map((step) => ({
      stage: step.stage,
      decision: step.decision,
      reason_code: step.reason_code,
      score_after: step.score_after,
      rank: step.rank,
      ...step.evidence,
    }))
    evidence.strategy_ids = [
      ...new Set(strategyPool.flatMap((step) => {
        const ids = step.evidence?.strategy_ids
      return Array.isArray(ids) ? ids.map(String) : []
      })),
    ]
  } else {
    const finalStrategyIds = candidateSeed?.evidence?.strategy_pool_ids ?? finalSelection?.evidence?.strategy_pool_ids
    if (Array.isArray(finalStrategyIds) && finalStrategyIds.length) {
      evidence.strategy_ids = [...new Set(finalStrategyIds.map(String).filter(Boolean))]
    }
  }
  if (diversity.length) {
    evidence.diversity_cooldown = diversity.map((step) => ({
      reason_code: step.reason_code,
      score_before: step.score_before,
      score_after: step.score_after,
      ...step.evidence,
    }))
  }

  return evidence
}

export function summarizeScreenerFunnelRows(rows: ScreenerFunnelRow[]): Map<string, ScreenerFunnelSummary> {
  const grouped = new Map<string, ScreenerFunnelStep[]>()
  for (const row of rows) {
    const symbol = normalizeSymbol(row.symbol)
    if (!symbol) continue
    const step: ScreenerFunnelStep = {
      stage: String(row.stage ?? ''),
      decision: String(row.decision ?? ''),
      reason_code: row.reason_code ?? null,
      score_before: toNullableNumber(row.score_before),
      score_after: toNullableNumber(row.score_after),
      rank: toNullableNumber(row.rank),
      evidence: parseEvidence(row.evidence),
    }
    const steps = grouped.get(symbol)
    if (steps) steps.push(step)
    else grouped.set(symbol, [step])
  }

  const summaries = new Map<string, ScreenerFunnelSummary>()
  for (const [symbol, steps] of grouped) {
    const candidateSeed = pickCandidateSeedStep(steps)
    summaries.set(symbol, {
      rank: candidateSeed?.rank ?? null,
      reason_code: candidateSeed?.reason_code ?? null,
      evidence: summarizeEvidence(steps),
      timeline: steps,
    })
  }
  return summaries
}

function layer125PortfolioSummaryFromFunnel(summary: ScreenerFunnelSummary | null | undefined): Record<string, unknown> | null {
  const raw = summary?.evidence?.layer125_finlab_portfolio_intelligence
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  return record.schema_version === 'layer125_finlab_portfolio_intelligence_summary_v1' ? record : null
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function maxNullable(values: Array<number | null>): number | null {
  const clean = values.filter((value): value is number => value != null && Number.isFinite(value))
  return clean.length ? Math.max(...clean) : null
}

function dominantStatus(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
  if (!entries.length) return 'missing'
  if (entries.length === 1) return entries[0][0]
  return 'mixed'
}

function inferPortfolioHealth(status: string, evidenceCount: number, metricCountMax: number | null): {
  usedLiveMetrics: boolean
  degradedReason: string | null
} {
  if (evidenceCount <= 0) {
    return { usedLiveMetrics: false, degradedReason: 'layer125_evidence_missing' }
  }
  if ((metricCountMax ?? 0) <= 0) {
    return { usedLiveMetrics: false, degradedReason: 'strategy_portfolio_metrics_empty' }
  }
  if (status === 'unavailable') {
    return { usedLiveMetrics: false, degradedReason: 'strategy_portfolio_metrics_unavailable' }
  }
  if (status === 'empty' || status === 'missing') {
    return { usedLiveMetrics: false, degradedReason: 'strategy_portfolio_metrics_empty' }
  }
  if (status === 'mixed') {
    return { usedLiveMetrics: true, degradedReason: 'mixed_strategy_portfolio_metric_status' }
  }
  return { usedLiveMetrics: true, degradedReason: null }
}

export function summarizeStrategyPortfolioIntelligenceHealth(
  summaries: Iterable<ScreenerFunnelSummary | null | undefined>,
  candidateCount?: number | null,
): StrategyPortfolioIntelligenceHealth {
  const summaryList = [...summaries]
  const portfolios = summaryList
    .map(layer125PortfolioSummaryFromFunnel)
    .filter((portfolio): portfolio is Record<string, unknown> => Boolean(portfolio))
  const statusCounts: Record<string, number> = {}
  const similarityStatusCounts: Record<string, number> = {}
  const sources = new Set<string>()
  const similaritySources = new Set<string>()
  const similarityOwners = new Set<string>()
  const similarityMedoidAlgorithms = new Set<string>()
  const metricCounts: Array<number | null> = []
  const backtestMetricCounts: Array<number | null> = []
  const backtestResultRowCounts: Array<number | null> = []
  let similarityBlockedCount = 0
  let similarityDegradedCount = 0

  for (const portfolio of portfolios) {
    const status = String(portfolio.portfolio_metric_status ?? 'unknown').trim() || 'unknown'
    incrementCount(statusCounts, status)
    const source = String(portfolio.portfolio_metric_source ?? '').trim()
    if (source) sources.add(source)
    const similarityStatus = String(portfolio.strategy_similarity_evidence_status ?? 'unknown').trim() || 'unknown'
    incrementCount(similarityStatusCounts, similarityStatus)
    const similaritySource = String(portfolio.strategy_similarity_evidence_source ?? '').trim()
    if (similaritySource) similaritySources.add(similaritySource)
    const similarityOwner = String(portfolio.strategy_similarity_algorithm_owner ?? '').trim()
    if (similarityOwner) similarityOwners.add(similarityOwner)
    const similarityMedoid = String(portfolio.strategy_similarity_medoid_algorithm ?? '').trim()
    if (similarityMedoid) similarityMedoidAlgorithms.add(similarityMedoid)
    if (String(portfolio.strategy_similarity_blocked_reason ?? '').trim()) similarityBlockedCount += 1
    else if (String(portfolio.strategy_similarity_degraded_reason ?? '').trim()) similarityDegradedCount += 1
    metricCounts.push(toNullableNumber(portfolio.portfolio_metric_count))
    backtestMetricCounts.push(toNullableNumber(portfolio.backtest_metric_count))
    backtestResultRowCounts.push(toNullableNumber(portfolio.backtest_result_row_count))
  }

  const totalCandidates = Math.max(0, Math.floor(candidateCount ?? summaryList.length))
  const evidenceCount = portfolios.length
  const metricCountMax = maxNullable(metricCounts)
  const status = dominantStatus(statusCounts)
  const inferred = inferPortfolioHealth(status, evidenceCount, metricCountMax)

  return {
    schema_version: 'daily_strategy_portfolio_intelligence_health_v1',
    layer: 'L1.25',
    source: 'screener_funnel_items.layer125_finlab_portfolio_intelligence',
    method: 'finlab_style_strategy_as_asset_portfolio_metrics',
    decision_policy: 'strategy_asset_weighting_not_stock_selector',
    selection_policy: 'no_stock_shrink_no_topk_no_minimum_fill',
    output_scope: 'strategy_prior_family_prior_reliability_crowding_diversification',
    consumed_by: 'layer15_multi_strategy_ple_router',
    candidate_count: totalCandidates,
    evidence_count: evidenceCount,
    coverage_ratio: totalCandidates > 0 ? Math.round((evidenceCount / totalCandidates) * 10000) / 10000 : 0,
    portfolio_metric_status: status,
    portfolio_metric_status_counts: statusCounts,
    portfolio_metric_sources: [...sources].sort(),
    strategy_similarity_evidence_status_counts: similarityStatusCounts,
    strategy_similarity_sources: [...similaritySources].sort(),
    strategy_similarity_algorithm_owners: [...similarityOwners].sort(),
    strategy_similarity_medoid_algorithms: [...similarityMedoidAlgorithms].sort(),
    strategy_similarity_blocked_count: similarityBlockedCount,
    strategy_similarity_degraded_count: similarityDegradedCount,
    metric_count_max: metricCountMax,
    metric_count_sum: Math.round(metricCounts.reduce((sum, value) => sum + (value ?? 0), 0)),
    backtest_metric_count_max: maxNullable(backtestMetricCounts),
    backtest_result_row_count_max: maxNullable(backtestResultRowCounts),
    layer125_evidence_available: evidenceCount > 0,
    used_live_strategy_asset_metrics: inferred.usedLiveMetrics,
    degraded_reason: inferred.degradedReason,
    no_stock_selection: true,
    no_topk: true,
  }
}
