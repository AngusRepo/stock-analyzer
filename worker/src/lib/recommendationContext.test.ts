import {
  buildHardGateSummary,
  buildMarketStructureWatchPoint,
  buildMlDiagnostics,
  buildMlVoteSummary,
  buildSparseAllocationSummary,
  compactRecommendationForCard,
} from './recommendationContext'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const watchPoint = buildMarketStructureWatchPoint({
    risk_overlay: {
      structure_detail: {
        poc_price: 911,
        fair_value_low: 786.43,
        fair_value_high: 855.88,
        optimistic_value_low: 855.88,
        optimistic_value_high: 879.03,
        optimistic_value_status: 'exceeded',
        upside_to_optimistic_high_pct: -0.0351,
        price_location: 'above_fair_value',
        window_start_date: '2026-04-16',
        window_end_date: '2026-05-04',
        latest_close: 911,
      },
    },
  })

  assert(watchPoint?.includes('optimistic_status=exceeded'), 'market structure watch point should expose exceeded optimistic status')
  assert(watchPoint?.includes('upside_to_optimistic_high_pct=-0.0351'), 'market structure watch point should expose upside gap')
}

{
  const gate = buildHardGateSummary({
    boardType: 'LISTED',
    tradabilityTier: 'auto_tradable',
    recommendationLane: 'tradable',
    marketSegment: 'LISTED',
    boardReason: 'regular_ohlc',
    persistedRecommendationLane: 'tradable',
    eligibleForMl: 1,
    eligibleForPendingBuy: 1,
  })

  assert(gate.schema_version === 'l05_hard_gate_summary_v1', 'L0.5 hard gate summary should expose a stable schema version')
  assert(gate.decision_policy === 'exclude_untradable_or_untrusted_only_not_alpha_ranker', 'L0.5 hard gate must not present itself as an alpha ranker')
  assert(gate.gate_scope === 'tradeability_data_trust_pending_buy', 'L0.5 hard gate scope should be explicit')
  assert(gate.ml_slate_allowed === true, 'tradable rows should remain eligible for ML slate')
  assert(gate.pending_buy_blocked === false, 'tradable rows should remain eligible for pending buy')

  const emerging = buildHardGateSummary({
    boardType: 'EMERGING',
    tradabilityTier: 'research_only',
    recommendationLane: 'emerging_watchlist',
    marketSegment: 'EMERGING',
    boardReason: 'emerging_price_shape',
    eligibleForMl: true,
    eligibleForPendingBuy: false,
  })
  assert(emerging.ml_slate_allowed === true, 'emerging rows may remain ML/research evaluable')
  assert(emerging.pending_buy_blocked === true, 'emerging rows must be blocked from pending buy')
  assert(emerging.hard_blocked === false, 'emerging watchlist should not be treated as the same as a blocked ETF/unknown board')

  const blocked = buildHardGateSummary({
    boardType: 'ETF',
    tradabilityTier: 'blocked',
    recommendationLane: 'research_only',
    boardReason: 'etf_excluded',
    eligibleForMl: 0,
    eligibleForPendingBuy: 0,
  })
  assert(blocked.hard_blocked === true, 'blocked/ETF rows should be hard gated out of the trade lane')
  assert(blocked.ml_slate_allowed === false, 'blocked rows must not be marked ML-slate allowed')
}

const forecastData = {
  ensemble_v2: {
    forecast_pct: 0.012,
    forecast_pct_source: 'empirical_rank_bins',
    forecast_calibration_method: 'empirical_rank_bins_monotonic',
    forecast_calibration_sample_count: 1880,
    forecast_calibration_bin_samples: 91,
    ic_weight_scope: 'tpex',
    rank_signal_thresholds: {
      buyThreshold: 0.58,
      sellThreshold: 0.42,
    },
    contributing_models: ['XGBoost', 'TabM', 'LightGBM'],
    ic_weight_diagnostics: {
      DLinear: { validation_status: 'FAIL' },
      PatchTST: { validation_status: 'PASS' },
    },
    weights: {
      XGBoost: 0.2,
      ExtraTrees: 0.1,
      LightGBM: 0.2,
      TabM: 0.1,
      GNN: 0.1,
      DLinear: 0.1,
      PatchTST: 0.1,
      iTransformer: 0.1,
      TimesFM: 0.1,
      KalmanFilter: 0.5,
      MarkovSwitching: 0.5,
      ResidualMLP: 0.5,
    },
  },
  dispersion_diagnostics: {
    raw_model_count: 9,
    raw_rank_std: 0.073,
    merge_compression: 0.62,
    weight_hhi: 0.18,
    zero_weight_models: ['DLinear'],
  },
}

{
  const summary = buildMlVoteSummary(forecastData, [
    { model_name: 'XGBoost', forecast_data: { rank_score: 0.8 } },
    { model_name: 'TabM', forecast_data: { rank_score: 0.7 } },
    { model_name: 'KalmanFilter', forecast_data: { rank_score: 0.9 } },
    { model_name: 'MarkovSwitching', forecast_data: { rank_score: 0.1 } },
    { model_name: 'ResidualMLP::challenger', forecast_data: { rank_score: 0.9 } },
  ])

  assert(summary?.total === 9, 'ML vote denominator must stay aligned with the new production alpha voters')
  assert(summary?.reported === 2, 'state-space overlays and challengers must not count as reported alpha votes')
  assert(summary?.forecastPct === 1.2, 'Worker card contract must expose forecastPct as display percent points')
  assert(summary?.activeWeightCount === 9, 'active weight count must ignore overlays and shadow models')
  assert(summary?.zeroWeightModels?.length === 0, 'all alpha models have positive lifecycle weights in this fixture')
}

{
  const diagnostics = buildMlDiagnostics(forecastData)

  assert(diagnostics?.totalAlphaModels === 9, 'diagnostics must use the new production alpha voters')
  assert(diagnostics?.activeWeightCount === 9, 'active weights must ignore overlays and challenger models')
  assert(diagnostics?.icWeightScope === 'tpex', 'diagnostics should expose the lane-aware IC scope')
  assert(diagnostics?.forecastCalibration.method === 'empirical_rank_bins_monotonic', 'forecast calibration method should be visible to UI')
  assert((diagnostics?.rankSignalThresholds as any)?.buyThreshold === 0.58, 'dynamic rank thresholds should be visible to UI')
  assert(diagnostics?.forecastCalibration.sampleCount === 1880, 'forecast calibration sample count should be visible to UI')
  assert(diagnostics?.dispersion.rawRankStd === 0.073, 'rank dispersion should be visible to UI')
  assert(diagnostics?.dispersion.mergeCompression === 0.62, 'rank compression should be visible to UI')
  assert(diagnostics?.zeroWeightModels?.[0] === 'DLinear', 'zero weight root-cause list should be visible to UI')
  assert(diagnostics?.validationBlockedModels?.[0] === 'DLinear', 'CPCV/PBO blocked models should be visible to UI')
}

{
  const allocation = buildSparseAllocationSummary(JSON.stringify({
    selected: true,
    engine: 'sparse_tangent_inverse_risk',
    controller: 'OnlinePortfolioBandit',
    allocation_weight: 0.375,
    buy_signal_count: 8,
    allocation_capacity: 8,
    sector_concentration_cap: 0.5,
    strategy_concentration_cap: 0.45,
    family_concentration_cap: 0.4,
    return_history_coverage: 5,
    return_history_symbols: ['2330', '2454'],
    eligible_for_sparse: true,
    allocation_rank: 1,
    expected_return: 0.0315,
    expected_return_source: 'ml_forecast_pct',
    positive_expected_edge: true,
    risk_estimate: 0.0182,
    risk_estimate_source: 'return_history_sample_std',
    selection_reason: 'selected_positive_edge_sparse_weight',
    sparse_diagnostics: {
      candidate_count: 42,
      evaluated_candidate_count: 8,
      allocation_capacity: 8,
      positive_edge_count: 6,
      selected_count: 3,
      zero_selection_allowed: true,
    },
    opb_controller: {
      enabled: true,
      stage: 'L3_production_allocation_controller',
      selection_policy: 'posterior_sample',
    },
  }))

  assert(allocation?.schema_version === 'l4_sparse_allocation_summary_v1', 'L4 sparse summary should expose a stable schema version')
  assert(allocation?.allocation_method === 'sparse_tangent_inverse_risk_final_allocation', 'L4 sparse summary should expose sparse final allocation method')
  assert(allocation?.input_scope === 'post_l3_5_evidence_fusion_candidates', 'L4 sparse summary should consume post-L3.5 evidence candidates')
  assert(allocation?.selection_policy === 'positive_expected_edge_sparse_weights_no_forced_fill', 'L4 sparse summary should require positive sparse edge without forced fill')
  assert(allocation?.decision_policy === 'final_owner_no_topk_fallback', 'L4 sparse summary should make the no-top-k policy explicit')
  assert(allocation?.capacity_policy === 'maximum_capacity_not_minimum_fill', 'L4 sparse summary should expose capacity as a maximum, not a fill target')
  assert(allocation?.upstream_conflict_policy === 'l3_5_flags_conflict_l4_decides_weight_not_drop', 'L4 sparse summary should document how L3.5 conflicts are consumed')
  assert(allocation?.final_decision_scope === 'buy_hold_weight_zero_to_capacity', 'L4 sparse summary should own final BUY/HOLD/weight decisions')
  assert(allocation?.max_capacity_not_target === true, 'L4 sparse allocation must treat capacity as max, not target')
  assert(allocation?.hard_minimum_fill === false, 'L4 sparse allocation must not enforce a hard minimum fill')
  assert(allocation?.allows_empty_portfolio === true, 'L4 sparse allocation must allow an empty portfolio')
  assert(allocation?.zero_selection_allowed === true, 'L4 sparse allocation must allow zero final BUY rows')
  assert(allocation?.legacy_topk_fallback_allowed === false, 'L4 sparse allocation must not allow legacy top-k fallback')
  assert(allocation?.legacy_rank_topk_fallback_allowed === false, 'L4 sparse allocation must explicitly reject rank-topK fallback')
  assert(allocation?.selected === true, 'selected rows should remain visible')
  assert(allocation?.allocation_weight === 0.375, 'allocation weight should be normalized to a number')
  assert(allocation?.allocation_capacity === 8, 'L4 sparse summary should expose allocation capacity')
  assert(allocation?.sector_concentration_cap === 0.5, 'L4 sparse summary should expose sector concentration cap')
  assert(allocation?.strategy_concentration_cap === 0.45, 'L4 sparse summary should expose strategy concentration cap')
  assert(allocation?.family_concentration_cap === 0.4, 'L4 sparse summary should expose family concentration cap')
  assert(allocation?.return_history_symbol_count === 2, 'return history symbol coverage should be compacted')
  assert(allocation?.eligible_for_sparse === true, 'L4 sparse summary should expose candidate eligibility')
  assert(allocation?.allocation_rank === 1, 'L4 sparse summary should expose sparse capacity rank')
  assert(allocation?.expected_return === 0.0315, 'L4 sparse summary should expose expected edge')
  assert(allocation?.expected_return_source === 'ml_forecast_pct', 'L4 sparse summary should expose expected edge source')
  assert(allocation?.positive_expected_edge === true, 'L4 sparse summary should expose positive edge decision')
  assert(allocation?.risk_estimate === 0.0182, 'L4 sparse summary should expose risk estimate')
  assert(allocation?.risk_estimate_source === 'return_history_sample_std', 'L4 sparse summary should expose risk estimate source')
  assert(allocation?.selection_reason === 'selected_positive_edge_sparse_weight', 'L4 sparse summary should expose selection reason')
  assert((allocation?.sparse_diagnostics as any)?.candidate_count === 42, 'L4 sparse summary should expose allocation-level diagnostics')
  assert((allocation?.opb_controller as any)?.enabled === true, 'OPB controller evidence should stay visible')

  const defaultController = buildSparseAllocationSummary({
    selected: false,
    engine: 'sparse_tangent_inverse_risk',
  })
  assert(defaultController?.controller === 'OnlinePortfolioBandit', 'L4 sparse summary should expose default OnlinePortfolioBandit controller provenance')

  assert(buildSparseAllocationSummary({ engine: 'rank_topk_equal_weight', selected: true }) === null, 'legacy top-k allocation must not be summarized as L4 sparse')
}

{
  const card = compactRecommendationForCard({
    symbol: '2330',
    prediction_forecast_data: forecastData,
    screener_funnel_timeline: [{ stage: 'seed' }],
    latest_open: 900,
    latest_avg_price: 905,
    ml_diagnostics: buildMlDiagnostics(forecastData),
  })

  assert(!('prediction_forecast_data' in card), 'card view should drop bulky forecast payload')
  assert(!('screener_funnel_timeline' in card), 'card view should drop bulky screener timeline')
  assert(card.ml_diagnostics?.dispersion?.rawRankStd === 0.073, 'card view must keep compact ML diagnostics')
  assert(card.ml_diagnostics?.forecastCalibration?.method === 'empirical_rank_bins_monotonic', 'card view must keep forecast calibration evidence')
}
