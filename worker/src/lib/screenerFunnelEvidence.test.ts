import { summarizeScreenerFunnelRows, summarizeStrategyPortfolioIntelligenceHealth } from './screenerFunnelEvidence'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '2330',
      stage: 'universe',
      decision: 'pass',
      reason_code: 'hard_filters_passed',
      evidence: JSON.stringify({ close: 910, avgVol20: 12000, avgDailyTurnover: 3_200_000_000 }),
    },
    {
      symbol: '2330',
      stage: 'scoring',
      decision: 'pass',
      reason_code: 'base_score_computed',
      score_after: 72,
      evidence: JSON.stringify({
        chip_score: 34,
        tech_score: 21,
        momentum_score: 17,
        score_components: JSON.stringify({ finalScore: 72 }),
        raw_signals: { closeAboveMa20Pct: 0.08 },
        taxonomy: { industry_theme: ['AI'] },
      }),
    },
    {
      symbol: '2330',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'pass',
      reason_code: 'selected_by_strategy_pool',
      rank: 18,
      score_after: 72,
      evidence: JSON.stringify({
        strategy_ids: ['trend_breakout'],
        strategy_family_ids: ['TREND_RECLAIM_CONTINUATION'],
        research_strategy_ids: ['research_shadow_only'],
        strategy_affinity_vector: { trend_breakout: 82, research_shadow_only: 31 },
        strategy_family_affinity: { TREND_RECLAIM_CONTINUATION: 82 },
        strategy_weak_label_vector: { trend_breakout: 0.82, research_shadow_only: 0.31 },
        strategy_hit_vector: { trend_breakout: 1, research_shadow_only: 1 },
        strategy_position_weight_vector: { trend_breakout: 0.74, research_shadow_only: 0.26 },
        strategy_overlap_vector: { trend_breakout: 0.21, research_shadow_only: 0.05 },
        selection_order: 'full_feature_enriched_universe_strategy_only_with_raw_signal_observe',
        strategy_labeler_version: 'strategy-labeler-v1',
        finlab_portfolio_intelligence_version: 'finlab-portfolio-intelligence-v1',
        strategy_router_version: 'multi-strategy-ple-router-v1',
        l15_router_slate_selection_policy: 'l15-adaptive-marginal-slate-builder-v1',
        strategy_router_decision: 'ml_slate',
        strategy_router_reason: 'l15_ple_router_selected_by_strategy_portfolio_evidence',
        strategy_router_components: {
          strategy_prior_weight: 1.2,
          family_prior_weight: 1.05,
          strategy_reliability: 0.74,
          strategy_crowding_score: 0.18,
          strategy_diversification_value: 0.82,
          marginal_utility_score: 84.2,
          marginal_selection_step: 1,
          learned_strategy_edge: 9.1,
          strategy_uniqueness_bonus: 7.4,
          family_diversification_bonus: 5.2,
          exploration_bonus: 0.8,
          overlap_penalty: 1.1,
          crowding_penalty: 0.9,
          new_strategy_ratio: 1,
          new_family_ratio: 1,
          strategy_rank_ic: 0.12,
          strategy_cluster_uniqueness: 0.91,
          teacher_alignment: 0.69,
        },
        strategy_portfolio_metric_source: 'strategy_reward_ledger+strategy_decision_log+backtest_results',
        strategy_portfolio_metric_status: 'ready',
        strategy_portfolio_metric_count: 11,
        strategy_portfolio_backtest_metric_count: 4,
        strategy_portfolio_backtest_result_row_count: 7,
        strategy_similarity_evidence_status: 'modal_python',
        strategy_similarity_evidence_source: 'modal_python',
        strategy_similarity_algorithm_owner: 'ml-service-modal-python',
        strategy_similarity_medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
        strategy_similarity_blocked_reason: null,
        candidate_route_score: 79,
        ml_slate_eligibility: 0.79,
        source_universe_count: 486,
        family_exposure: { TREND_RECLAIM_CONTINUATION: 1 },
        diversity_contribution: 0.82,
        risk_adjusted_affinity: 76,
        uncertainty: 0.18,
        runtime_teacher_evidence: { LightGBM: 0.8, GNN: 0.7, TimesFM: 0.62 },
        runtime_teacher_evidence_source: 'historical_verified_cache',
        ml_teacher_labels: { LightGBM: 0.8, GNN: 0.7, TimesFM: 0.62 },
      }),
    },
    {
      symbol: '2330',
      stage: 'layer2_coarse_ml_gate',
      decision: 'observe',
      reason_code: 'l2_tree_evidence_l3_queue_selected',
      rank: 6,
      score_after: 72,
      evidence: JSON.stringify({
        coarse_ml_queue_size: 80,
        core_ml_shortlist_size: 35,
        selection_role: 'evidence_only_l3_formal_inference_queue',
        final_recommendation_gate: false,
        l3_formal_inference_selected: true,
      }),
    },
    {
      symbol: '2330',
      stage: 'layer3_formal_ml_gate',
      decision: 'pass',
      reason_code: 'formal_family_evidence_pass',
      rank: 4,
      score_before: 72,
      score_after: 0.81,
      evidence: JSON.stringify({
        schema_version: 'layer3_formal_ml_gate_audit_v1',
        active_family_count: 3,
        active_families: ['tree', 'graph', 'time_series'],
        contributing_models: ['LightGBM', 'GNN', 'TimesFM'],
        weights: { LightGBM: 0.5, GNN: 0.3, TimesFM: 0.2 },
      }),
    },
    {
      symbol: '2330',
      stage: 'rrg_overlay',
      decision: 'observe',
      reason_code: 'rrg_overlay_leading_confirmed',
      score_before: 72,
      score_after: 75,
      evidence: JSON.stringify({ tag: 'AI', quadrant: 'Leading', adjustment: 3 }),
    },
    {
      symbol: '2330',
      stage: 'buzz_evidence',
      decision: 'observe',
      reason_code: 'weighted_keyword_evidence',
      score_before: 75,
      score_after: 77,
      evidence: JSON.stringify({ concept: 'AI', sourceStrength: 1.8, buzzBonus: 2 }),
    },
    {
      symbol: '2330',
      stage: 'diversity_cooldown',
      decision: 'observe',
      reason_code: 'high_frequency_cooldown',
      score_before: 77,
      score_after: 71,
      evidence: JSON.stringify({ freq20d: 14, highFreqPenalty: 6 }),
    },
    {
      symbol: '2330',
      stage: 'final_selection',
      decision: 'selected',
      reason_code: 'selected_for_ml_shortlist',
      rank: 4,
      score_after: 71,
      evidence: JSON.stringify({ industry: '半導體', strategy_tags: ['breakout'] }),
    },
  ])

  const summary = summaries.get('2330')
  assert(summary?.rank === 4, 'final selection rank must be preserved')
  assert(summary?.reason_code === 'selected_for_ml_shortlist', 'final reason must be preserved')
  assert(summary?.timeline.length === 9, 'timeline must retain all screener stages')
  assert((summary?.evidence.layer0_universe_features as any)?.schema_version === 'layer0_universe_features_summary_v1', 'Layer0 universe/features evidence must expose a stable summary schema')
  assert((summary?.evidence.layer0_universe_features as any)?.decision_policy === 'feature_materialization_only_not_selector', 'Layer0 feature materialization must not be summarized as a selector')
  assert((summary?.evidence.layer0_universe_features as any)?.selection_policy === 'no_topk_no_shrink', 'Layer0 summary must explicitly reject top-k/shrink semantics')
  assert((summary?.evidence.layer0_universe_features as any)?.source_universe_count === 486, 'Layer0 summary should carry source universe count when available')
  assert((summary?.evidence.layer0_universe_features as any)?.feature_group_count === 4, 'Layer0 summary should count available feature groups')
  assert((summary?.evidence.layer0_universe_features as any)?.has_score_v2_components === true, 'Layer0 summary should expose Score V2 component coverage')
  assert((summary?.evidence.layer0_universe_features as any)?.has_strategy_raw_signals === true, 'Layer0 summary should expose strategy raw signal coverage')
  assert((summary?.evidence.layer1_breadth as any)?.rank === 18, 'Layer1 breadth evidence must be summarized')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.schema_version === 'layer1_strategy_labeler_summary_v1', 'Layer1 strategy labeler evidence must expose a stable summary schema')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.decision_policy === 'label_all_candidates_not_selector', 'Layer1 strategy labeler must not be summarized as a stock selector')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.selection_policy === 'no_topk_no_shrink_no_minimum_fill', 'Layer1 strategy labeler must explicitly reject top-k/shrink/minimum-fill semantics')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.label_scope === 'strategy_affinity_family_affinity_weak_labels', 'Layer1 strategy labeler must expose the multi-strategy label scope')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.strategy_count === 2, 'Layer1 labeler should count active and research strategy labels')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.active_strategy_count === 1, 'Layer1 labeler should count active production labels separately')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.research_strategy_count === 1, 'Layer1 labeler should count research labels separately')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.family_count === 1, 'Layer1 labeler should expose family coverage')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.has_strategy_affinity_vector === true, 'Layer1 labeler should expose strategy affinity vector coverage')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.has_family_affinity_vector === true, 'Layer1 labeler should expose family affinity vector coverage')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.has_weak_label_vector === true, 'Layer1 labeler should expose weak label vector coverage')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.has_position_weight_vector === true, 'Layer1 labeler should expose position weight vector coverage')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.has_overlap_vector === true, 'Layer1 labeler should expose overlap vector coverage')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.max_strategy_affinity === 82, 'Layer1 labeler should keep raw affinity scale for audit')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.strategy_hit_count === 2, 'Layer1 labeler should count hit labels')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.position_weight_sum === 1, 'Layer1 labeler should expose normalized position-weight sum')
  assert((summary?.evidence.layer1_strategy_labeler as any)?.max_strategy_overlap === 0.21, 'Layer1 labeler should expose overlap risk evidence')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.schema_version === 'layer125_finlab_portfolio_intelligence_summary_v1', 'Layer1.25 FinLab portfolio intelligence evidence must expose a stable summary schema')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.decision_policy === 'strategy_asset_weighting_not_stock_selector', 'Layer1.25 FinLab portfolio intelligence must not be summarized as a stock selector')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.selection_policy === 'no_stock_shrink_no_topk_no_minimum_fill', 'Layer1.25 FinLab portfolio intelligence must not shrink/fill the stock slate')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.output_scope === 'strategy_prior_family_prior_reliability_crowding_diversification', 'Layer1.25 summary should expose strategy-as-asset output scope')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.consumed_by === 'layer15_multi_strategy_ple_router', 'Layer1.25 should be consumed by L1.5 router')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.finlab_portfolio_intelligence_version === 'finlab-portfolio-intelligence-v1', 'Layer1.25 version must remain visible')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.portfolio_metric_source === 'strategy_reward_ledger+strategy_decision_log+backtest_results', 'Layer1.25 metric source must remain visible')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.portfolio_metric_status === 'ready', 'Layer1.25 metric readiness must remain visible')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.portfolio_metric_count === 11, 'Layer1.25 metric count must remain visible')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.backtest_metric_count === 4, 'Layer1.25 backtest metric count must remain visible')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_similarity_evidence_status === 'modal_python', 'Layer1.25 should expose Modal strategy similarity status')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_similarity_algorithm_owner === 'ml-service-modal-python', 'Layer1.25 strategy similarity owner must be Modal/Python')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_similarity_medoid_algorithm === "sklearn_extra.cluster.KMedoids(method='pam')", 'Layer1.25 should expose official PAM medoid evidence')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_similarity_scope === 'strategy_supported_symbols_graph_evidence_not_stock_selector', 'Layer1.25 similarity evidence must not become a stock selector')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_prior_weight === 1.2, 'Layer1.25 strategy prior should remain unnormalized')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.family_prior_weight === 1.05, 'Layer1.25 family prior should remain unnormalized')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_reliability === 0.74, 'Layer1.25 reliability should be normalized')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_crowding_score === 0.18, 'Layer1.25 crowding score should be normalized')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.strategy_diversification_value === 0.82, 'Layer1.25 diversification value should be normalized')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.max_holding_overlap === 0.21, 'Layer1.25 should expose overlap risk evidence')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.crowding_action === 'allow_strategy_support', 'Layer1.25 low crowding should allow strategy support')
  assert((summary?.evidence.layer125_finlab_portfolio_intelligence as any)?.reliability_action === 'increase_prior_weight', 'Layer1.25 high reliability should increase prior weight')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.schema_version === 'layer15_multi_strategy_router_summary_v1', 'Layer1.5 router evidence must be summarized')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.router_method === 'multi_strategy_ple_listwise_distillation_router', 'Layer1.5 router must expose PLE/Listwise method')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.router_scope === 'full_candidate_slate_to_diversified_ml_slate', 'Layer1.5 router must route the full slate into diversified ML slate')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.decision_policy === 'diversified_ml_slate_not_topk', 'Layer1.5 router must not be summarized as top-k ranking')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.selection_policy === 'quality_floor_max_capacity_no_forced_fill', 'Layer1.5 router must expose quality-floor max-capacity selection policy')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.slate_selection_policy === 'l15-adaptive-marginal-slate-builder-v1', 'Layer1.5 router must expose adaptive marginal slate selection policy')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.self_learning_loop === 'strategy_decision_log_to_strategy_reward_ledger_to_strategy_portfolio_metrics_to_l15_marginal_utility', 'Layer1.5 router must expose reward-ledger feedback loop')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.capacity_policy === 'max_only_no_minimum_no_topup', 'Layer1.5 router must expose max-only capacity policy')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.no_minimum_fill === true, 'Layer1.5 router must explicitly reject minimum fill')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.is_topk_ranker === false, 'Layer1.5 router must explicitly reject top-k ranker semantics')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.output_scope === 'candidate_route_score_ml_slate_eligibility_family_exposure_diversity_risk_uncertainty', 'Layer1.5 router must expose router output scope')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.teacher_label_scope === 'training_teacher_labels_offline_runtime_teacher_evidence_optional', 'Layer1.5 router must expose offline training labels vs optional runtime teacher evidence scope')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.runtime_teacher_evidence_policy === 'previous_trading_day_or_latest_verified_cache_no_same_day_l2_l3_dependency', 'Layer1.5 runtime teacher evidence must not depend on same-day L2/L3')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.runtime_teacher_evidence_source === 'historical_verified_cache', 'Layer1.5 should expose runtime teacher evidence source')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.expected_teacher_count === 9, 'Layer1.5 router must keep 9ML teacher-label contract')
  assert(((summary?.evidence.layer15_multi_strategy_router as any)?.expected_teacher_models ?? []).join(',') === 'LightGBM,XGBoost,ExtraTrees,TabM,GNN,DLinear,PatchTST,iTransformer,TimesFM', 'Layer1.5 expected teacher models must include L2/L3 9ML')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.teacher_label_count === 3, 'Layer1.5 router should count available teacher labels')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.no_topup_policy_scope === 'formal_ml_slate_no_minimum_fill', 'Layer1.5 no-topup policy must scope to formal ML slate')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.observe_topup_policy === 'research_observe_only_never_formal_l2', 'Layer1 observe top-up policy must stay research/observe only')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.formal_l2_queue === true, 'L1.5 selected candidate must declare formal L2 queue eligibility')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.observe_only_top_up === false, 'L1.5 selected candidate must not be confused with observe-only top-up')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.route_score === 0.79, 'Layer1.5 route score should be normalized for UI')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.strategy_count === 1, 'Layer1.5 summary should count production strategy support')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.research_strategy_count === 1, 'Layer1.5 summary should keep research attribution separate')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.portfolio_metric_source === 'strategy_reward_ledger+strategy_decision_log+backtest_results', 'Layer1.25 FinLab-style metric source must remain visible')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.reward_feedback_source === 'strategy_reward_ledger+strategy_decision_log+backtest_results', 'Layer1.5 marginal utility must expose reward feedback source')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.strategy_prior_weight === 1.2, 'Layer1.25 strategy prior should remain unnormalized')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.marginal_utility_score === 84.2, 'Layer1.5 summary should expose marginal utility score')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.learned_strategy_edge === 9.1, 'Layer1.5 summary should expose learned strategy edge')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.new_strategy_ratio === 1, 'Layer1.5 summary should expose strategy novelty signal')
  assert((summary?.evidence.layer15_multi_strategy_router as any)?.strategy_rank_ic === 0.12, 'Layer1.5 summary should expose learned RankIC signal')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.schema_version === 'layer2_3ml_coarse_summary_v1', 'Layer2 3ML coarse evidence must expose a stable summary schema')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.decision_policy === 'three_ml_coarse_evidence_l3_queue_not_final_ranker', 'Layer2 3ML coarse must not be summarized as final ranking')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.expected_model_count === 3, 'Layer2 3ML coarse should keep the 3-model contract')
  assert(((summary?.evidence.layer2_3ml_coarse as any)?.expected_models ?? []).join(',') === 'LightGBM,XGBoost,ExtraTrees', 'Layer2 3ML coarse model ids must stay visible')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.core_ml_evidence === true, 'Layer2 core ML evidence flag must be explicit when controller evidence exists')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.formal_l2_evidence === true, 'Layer2 formal evidence must be explicit when controller evidence exists')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.formal_l2_pass === false, 'Layer2 formal evidence must not be exposed as final recommendation pass')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.final_recommendation_gate === false, 'Layer2 coarse queue must not be a final recommendation gate')
  assert((summary?.evidence.layer2_coarse_ml as any)?.coarse_ml_queue_size === 80, 'Layer2 coarse ML evidence must be summarized')
  assert((summary?.evidence.layer3_6ml_formal as any)?.schema_version === 'layer3_6ml_formal_summary_v1', 'Layer3 6ML formal evidence must expose a stable summary schema')
  assert((summary?.evidence.layer3_6ml_formal as any)?.decision_policy === 'six_ml_formal_family_vote_not_topk', 'Layer3 formal ML must be family-vote evidence, not top-k')
  assert((summary?.evidence.layer3_6ml_formal as any)?.expected_model_count === 6, 'Layer3 formal should keep the 6-model contract')
  assert(((summary?.evidence.layer3_6ml_formal as any)?.expected_models ?? []).join(',') === 'TabM,GNN,DLinear,PatchTST,iTransformer,TimesFM', 'Layer3 formal model ids must stay visible')
  assert((summary?.evidence.layer3_6ml_formal as any)?.active_l3_model_count === 2, 'Layer3 formal summary should count active L3 contributors separately from L2 contributors')
  assert((summary?.evidence.layer3_formal_ml as any)?.active_family_count === 3, 'Layer3 formal ML evidence must be summarized')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.schema_version === 'layer35_evidence_fusion_v1', 'Layer3.5 evidence fusion must expose a stable summary schema')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.fusion_method === 'strategy_router_vs_9ml_formal_family_evidence_calibration', 'Layer3.5 fusion must expose strategy-vs-9ML calibration method')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.input_scope === 'layer15_route_score_layer3_formal_family_score_uncertainty_active_family_count', 'Layer3.5 fusion must expose input scope')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.decision_policy === 'observe_only_no_hard_shrink', 'Layer3.5 evidence fusion must not hard-shrink candidates')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.selection_policy === 'no_candidate_drop_no_topk_no_minimum_fill', 'Layer3.5 evidence fusion must not drop/top-k/fill candidates')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.hard_shrink_allowed === false, 'Layer3.5 evidence fusion must explicitly reject hard shrink')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.is_final_allocator === false, 'Layer3.5 evidence fusion must not masquerade as final allocator')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.final_allocation_owner === 'layer4_sparse_allocation', 'Layer3.5 evidence fusion must defer final allocation to L4 sparse')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.output_scope === 'conflict_level_strategy_ml_score_gap_supportive_or_conflicted_evidence', 'Layer3.5 fusion must expose output scope')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.route_evidence_available === true, 'Layer3.5 should mark L1.5 route evidence availability')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.formal_ml_evidence_available === true, 'Layer3.5 should mark L3 formal ML evidence availability')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.active_l3_family_sufficient === true, 'Layer3.5 should mark sufficient L3 family evidence')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.conflict_level === 'low', 'aligned L1.5 route and L3 formal family score should be low conflict')
  assert((summary?.evidence.layer35_evidence_fusion as any)?.recommended_action === 'allow_downstream_sparse_allocation', 'low conflict should allow downstream sparse allocation')
  assert((summary?.evidence.rrg_overlay as any)?.quadrant === 'Leading', 'RRG overlay evidence must be summarized')
  assert((summary?.evidence.buzz_evidence as any)?.concept === 'AI', 'buzz evidence must be summarized')
  assert(Array.isArray(summary?.evidence.diversity_cooldown), 'diversity/cooldown evidence must be summarized')
  assert(Array.isArray(summary?.evidence.decision_path), 'decision path must be UI-readable')
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '2330',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'pass',
      reason_code: 'l15_ple_router_selected_by_strategy_portfolio_evidence',
      evidence: JSON.stringify({
        finlab_portfolio_intelligence_version: 'finlab-portfolio-intelligence-v1',
        strategy_portfolio_metric_source: 'strategy_reward_ledger+strategy_decision_log+backtest_results',
        strategy_portfolio_metric_status: 'ready',
        strategy_portfolio_metric_count: 11,
        strategy_portfolio_backtest_metric_count: 4,
        strategy_portfolio_backtest_result_row_count: 3,
        strategy_similarity_evidence_status: 'modal_python',
        strategy_similarity_evidence_source: 'modal_python',
        strategy_similarity_algorithm_owner: 'ml-service-modal-python',
        strategy_similarity_medoid_algorithm: "sklearn_extra.cluster.KMedoids(method='pam')",
        strategy_router_components: {
          strategy_prior_weight: 1.2,
          family_prior_weight: 1.05,
          strategy_reliability: 0.74,
          strategy_crowding_score: 0.18,
          strategy_diversification_value: 0.82,
        },
      }),
    },
    {
      symbol: '2317',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'pass',
      reason_code: 'l15_ple_router_selected_by_strategy_portfolio_evidence',
      evidence: JSON.stringify({
        finlab_portfolio_intelligence_version: 'finlab-portfolio-intelligence-v1',
        strategy_portfolio_metric_source: 'strategy_reward_ledger+strategy_decision_log+backtest_results',
        strategy_portfolio_metric_status: 'ready',
        strategy_portfolio_metric_count: 9,
        strategy_portfolio_backtest_metric_count: 2,
        strategy_similarity_evidence_status: 'unavailable_blocked',
        strategy_similarity_evidence_source: 'missing',
        strategy_similarity_algorithm_owner: 'not_computed',
        strategy_similarity_blocked_reason: 'controller_unavailable',
      }),
    },
  ])
  const health = summarizeStrategyPortfolioIntelligenceHealth(summaries.values(), 3)
  assert(health.schema_version === 'daily_strategy_portfolio_intelligence_health_v1', 'daily L1.25 health must expose a stable schema')
  assert(health.layer === 'L1.25', 'daily L1.25 health must identify the fused-roadmap layer')
  assert(health.decision_policy === 'strategy_asset_weighting_not_stock_selector', 'daily L1.25 health must not describe portfolio intelligence as a stock selector')
  assert(health.selection_policy === 'no_stock_shrink_no_topk_no_minimum_fill', 'daily L1.25 health must reject shrink/top-k/minimum-fill semantics')
  assert(health.evidence_count === 2, 'daily L1.25 health should count rows with portfolio evidence')
  assert(health.candidate_count === 3, 'daily L1.25 health should preserve the full candidate denominator')
  assert(health.coverage_ratio === 0.6667, 'daily L1.25 health should expose evidence coverage ratio')
  assert(health.portfolio_metric_status === 'ready', 'daily L1.25 health should expose dominant metric status')
  assert(health.metric_count_max === 11, 'daily L1.25 health should expose maximum strategy metric coverage')
  assert(health.metric_count_sum === 20, 'daily L1.25 health should expose aggregate strategy metric coverage')
  assert(health.backtest_metric_count_max === 4, 'daily L1.25 health should expose backtest metric coverage')
  assert(health.strategy_similarity_evidence_status_counts.modal_python === 1, 'daily L1.25 health should count Modal strategy similarity evidence')
  assert(health.strategy_similarity_evidence_status_counts.unavailable_blocked === 1, 'daily L1.25 health should count blocked strategy similarity evidence')
  assert(health.strategy_similarity_sources.includes('modal_python'), 'daily L1.25 health should expose Modal strategy similarity source')
  assert(health.strategy_similarity_algorithm_owners.includes('ml-service-modal-python'), 'daily L1.25 health should expose Modal/Python similarity owner')
  assert(health.strategy_similarity_medoid_algorithms.includes("sklearn_extra.cluster.KMedoids(method='pam')"), 'daily L1.25 health should expose official PAM medoid algorithm')
  assert(health.strategy_similarity_blocked_count === 1, 'daily L1.25 health should count blocked similarity evidence rows')
  assert(health.strategy_similarity_degraded_count === 0, 'new daily L1.25 health should not produce degraded similarity evidence rows')
  assert(health.used_live_strategy_asset_metrics === true, 'ready non-empty L1.25 metrics should be marked live')
  assert(health.no_stock_selection === true && health.no_topk === true, 'daily L1.25 health must preserve non-selector contract flags')

  const missing = summarizeStrategyPortfolioIntelligenceHealth([], 5)
  assert(missing.portfolio_metric_status === 'missing', 'missing L1.25 evidence should not masquerade as ready')
  assert(missing.degraded_reason === 'layer125_evidence_missing', 'missing L1.25 evidence should expose degraded reason')
  assert(missing.used_live_strategy_asset_metrics === false, 'missing L1.25 evidence must not claim live strategy asset metrics')
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '1215',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'pass',
      reason_code: 'selected_by_raw_factor_strategy',
      rank: 44,
      score_after: 62,
      evidence: JSON.stringify({ strategy_ids: ['raw_chip_accumulation'] }),
    },
    {
      symbol: '1215',
      stage: 'l1_candidate_seed_after_overlay',
      decision: 'selected',
      reason_code: 'selected_for_l1_breadth_seed',
      rank: 37,
      score_after: 61,
      evidence: JSON.stringify({
        semantic_stage: 'l1_candidate_seed_after_overlay',
        legacy_alias_stage: 'final_selection',
        strategy_pool_ids: ['raw_chip_accumulation'],
      }),
    },
  ])

  const summary = summaries.get('1215')
  assert(summary?.rank === 37, 'L1 candidate seed alias rank must be preserved without legacy final_selection rows')
  assert(summary?.reason_code === 'selected_for_l1_breadth_seed', 'L1 candidate seed alias reason must be preserved')
  assert(summary?.evidence.semantic_stage === 'l1_candidate_seed_after_overlay', 'summary evidence must expose semantic L1 seed stage')
  assert(Array.isArray(summary?.evidence.strategy_ids), 'semantic L1 seed strategy ids must be exposed')
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '8999',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'observe',
      reason_code: 'raw_signal_top_up_observe_after_l15_adaptive_slate',
      rank: 88,
      score_after: 54,
      evidence: JSON.stringify({
        strategy_pool_fallback_source: 'raw_signal_top_up',
        strategy_pool_decision: 'research_only_queue',
        strategy_pool_reason: 'raw_signal_top_up_observe_after_l15_adaptive_slate',
        formal_l2_queue: false,
        candidate_route_score: 41,
      }),
    },
  ])

  const router = summaries.get('8999')?.evidence.layer15_multi_strategy_router as any
  assert(router?.capacity_policy === 'max_only_no_minimum_no_topup', 'observe top-up still reports the L1.5 max-only policy')
  assert(router?.no_topup_policy_scope === 'formal_ml_slate_no_minimum_fill', 'observe top-up must clarify no-topup scope')
  assert(router?.observe_topup_policy === 'research_observe_only_never_formal_l2', 'observe top-up must stay out of formal L2')
  assert(router?.formal_l2_queue === false, 'raw-signal observe top-up must not become formal L2 queue evidence')
  assert(router?.observe_only_top_up === true, 'raw-signal top-up must be explicitly observable as observe-only')
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '2454',
      stage: 'layer1_strategy_breadth_gate',
      decision: 'pass',
      reason_code: 'l15_ple_router_selected_by_strategy_portfolio_evidence',
      rank: 2,
      score_after: 82,
      evidence: JSON.stringify({ candidate_route_score: 86, uncertainty: 0.22 }),
    },
    {
      symbol: '2454',
      stage: 'layer3_formal_ml_gate',
      decision: 'drop',
      reason_code: 'formal_family_insufficient_active_families',
      rank: 2,
      score_after: 0.42,
      evidence: JSON.stringify({
        active_family_count: 1,
        contributing_models: ['LightGBM', 'ExtraTrees'],
      }),
    },
  ])

  const fusion = summaries.get('2454')?.evidence.layer35_evidence_fusion as any
  assert(fusion?.conflict_level === 'high', 'L3.5 should flag high strategy-vs-ML conflict when L3 family evidence is weak')
  assert(fusion?.decision === 'conflicted', 'L3.5 fusion should expose conflicted evidence without hiding the timeline')
  assert(fusion?.recommended_action === 'flag_conflict_for_l4_sparse_without_hard_drop', 'high conflict should flag L4 sparse without hard-dropping the candidate')
  assert(fusion?.hard_shrink_allowed === false, 'high conflict must still not become hard-shrink logic')
  assert(fusion?.active_l3_family_sufficient === false, 'weak L3 family evidence should be explicit')
  assert(summaries.get('2454')?.timeline.length === 2, 'conflicted candidates should remain auditable in the timeline')
}

{
  const summaries = summarizeScreenerFunnelRows([
    {
      symbol: '2330',
      stage: 'l15_ml_slate_queue',
      decision: 'observe',
      reason_code: 'ml_slate_queue_seed_from_l1_5_router',
      rank: 3,
      score_after: 70,
      evidence: JSON.stringify({ worker_seed_only: true, downstream_owner: 'ml-controller', downstream_stage: 'layer2_coarse_ml_gate' }),
    },
  ])

  const summary = summaries.get('2330')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.worker_seed_only === true, 'worker seed should be explicit in the Layer2 3ML summary')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.core_ml_evidence === false, 'worker seed must not claim controller core ML evidence')
  assert((summary?.evidence.layer2_3ml_coarse as any)?.formal_l2_pass === false, 'worker seed must not become a formal L2 pass')
  assert(!summary?.evidence.layer2_coarse_ml, 'worker seed must not be summarized as formal L2 coarse ML pass')
  assert((summary?.evidence.layer15_ml_slate_queue as any)?.downstream_stage === 'layer2_coarse_ml_gate', 'L1.5 slate queue should expose the downstream L2 owner')
  assert((summary?.evidence.layer2_queue_seed as any)?.worker_seed_only === true, 'worker seed should stay visible as queue seed evidence')
}
