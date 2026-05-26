import { buildMarketStructureWatchPoint, buildMlDiagnostics, buildMlVoteSummary, compactRecommendationForCard } from './recommendationContext'

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

  assert(watchPoint?.startsWith('Alpha 結構:'), 'market structure watch point should not pretend alpha proxy is an OHLCV trade plan')
  assert(watchPoint?.includes('內部合理區 786.43~855.88'), 'alpha proxy should name the internal reasonable zone')
  assert(watchPoint?.includes('內部順風區 855.88~879.03'), 'alpha proxy should name the internal optimistic zone without calling it resistance')
  assert(watchPoint?.includes('已高於內部順風上緣 3.5%'), 'alpha proxy should translate extension into plain language')
  assert(watchPoint?.includes('內部估值提醒偏追高'), 'alpha proxy should translate exceeded extension into action language')
  assert(!watchPoint?.includes('前高壓力'), 'alpha proxy must not be mislabeled as OHLCV resistance')
  assert(!watchPoint?.includes('轉強確認'), 'alpha proxy must not be mislabeled as OHLCV confirmation')
  for (const internalTerm of ['POC', 'fair_value', 'optimistic_value', 'optimistic_status', 'above_fair_value']) {
    assert(!watchPoint?.includes(internalTerm), `trading plan should not expose internal quant label ${internalTerm}`)
  }
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
    contributing_models: ['XGBoost', 'CatBoost', 'LightGBM'],
    ic_weight_diagnostics: {
      DLinear: { validation_status: 'FAIL' },
      PatchTST: { validation_status: 'PASS' },
    },
    weights: {
      XGBoost: 0.2,
      CatBoost: 0.1,
      ExtraTrees: 0.1,
      LightGBM: 0.2,
      'FT-Transformer': 0.1,
      Chronos: 0.1,
      DLinear: 0.1,
      PatchTST: 0.1,
      KalmanFilter: 0.5,
      MarkovSwitching: 0.5,
      ResidualMLP: 0.5,
      GNN: 0.5,
    },
  },
  dispersion_diagnostics: {
    raw_model_count: 8,
    raw_rank_std: 0.073,
    merge_compression: 0.62,
    weight_hhi: 0.18,
    zero_weight_models: ['DLinear'],
  },
}

{
  const summary = buildMlVoteSummary(forecastData, [
    { model_name: 'XGBoost', forecast_data: { rank_score: 0.8 } },
    { model_name: 'CatBoost', forecast_data: { rank_score: 0.7 } },
    { model_name: 'KalmanFilter', forecast_data: { rank_score: 0.9 } },
    { model_name: 'MarkovSwitching', forecast_data: { rank_score: 0.1 } },
    { model_name: 'ResidualMLP::challenger', forecast_data: { rank_score: 0.9 } },
  ])

  assert(summary?.total === 8, 'ML vote denominator must stay at 8 alpha prediction voters')
  assert(summary?.reported === 2, 'state-space overlays and challengers must not count as reported alpha votes')
  assert(summary?.forecastPct === 1.2, 'Worker card contract must expose forecastPct as display percent points')
  assert(summary?.activeWeightCount === 8, 'active weight count must ignore overlays and shadow models')
  assert(summary?.zeroWeightModels?.length === 0, 'all eight alpha models have positive lifecycle weights in this fixture')
}

{
  const diagnostics = buildMlDiagnostics(forecastData)

  assert(diagnostics?.totalAlphaModels === 8, 'diagnostics must use the eight production alpha voters')
  assert(diagnostics?.activeWeightCount === 8, 'active weights must ignore overlays and challenger models')
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
