import { buildMarketStructureWatchPoint, buildMlVoteSummary } from './recommendationContext'

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

const forecastData = {
  ensemble_v2: {
    forecast_pct: 0.012,
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
  assert(summary?.activeWeightCount === 8, 'active weight count must ignore overlays and shadow models')
  assert(summary?.zeroWeightModels?.length === 0, 'all eight alpha models have positive lifecycle weights in this fixture')
}
