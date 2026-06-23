-- Morning Setup P0-P7 post-deploy validation, read-only.
-- Do not put mutation statements in this file.
--
-- Remote D1 note:
--   Do not run this read-only audit with `--remote --file`; Wrangler treats
--   remote files as imports. Use each SELECT below with `--command`, or run
--   this file only against a local/exported mirror.

SELECT
  'p7_schema_pending_buy_filter_audit' AS audit,
  SUM(CASE WHEN type = 'table' AND name = 'pending_buy_filter_audit' THEN 1 ELSE 0 END) AS table_count,
  SUM(CASE WHEN type = 'index' AND name = 'idx_pending_buy_filter_audit_run' THEN 1 ELSE 0 END) AS run_index_count,
  SUM(CASE WHEN type = 'index' AND name = 'idx_pending_buy_filter_audit_trade_date' THEN 1 ELSE 0 END) AS trade_date_index_count,
  SUM(CASE WHEN type = 'index' AND name = 'idx_pending_buy_filter_audit_reason' THEN 1 ELSE 0 END) AS reason_index_count
FROM sqlite_schema
WHERE name IN (
  'pending_buy_filter_audit',
  'idx_pending_buy_filter_audit_run',
  'idx_pending_buy_filter_audit_trade_date',
  'idx_pending_buy_filter_audit_reason'
);

SELECT
  'p7_latest_pending_buy_run' AS audit,
  id,
  trade_date,
  source_reco_date,
  status,
  debate_status,
  candidate_count,
  error_message,
  created_at,
  updated_at
FROM pending_buy_runs
ORDER BY id DESC
LIMIT 1;

SELECT
  'p7_schema_sector_flow_rotation_model' AS audit,
  SUM(CASE WHEN name = 'rotation_velocity' THEN 1 ELSE 0 END) AS rotation_velocity_column,
  SUM(CASE WHEN name = 'rotation_acceleration' THEN 1 ELSE 0 END) AS rotation_acceleration_column,
  SUM(CASE WHEN name = 'quadrant_age' THEN 1 ELSE 0 END) AS quadrant_age_column,
  SUM(CASE WHEN name = 'transition_path' THEN 1 ELSE 0 END) AS transition_path_column,
  SUM(CASE WHEN name = 'rotation_score' THEN 1 ELSE 0 END) AS rotation_score_column,
  SUM(CASE WHEN name = 'rotation_regime' THEN 1 ELSE 0 END) AS rotation_regime_column,
  SUM(CASE WHEN name = 'rotation_hysteresis' THEN 1 ELSE 0 END) AS rotation_hysteresis_column,
  SUM(CASE WHEN name = 'rotation_window' THEN 1 ELSE 0 END) AS rotation_window_column,
  SUM(CASE WHEN name = 'rrg_tail_json' THEN 1 ELSE 0 END) AS rrg_tail_json_column
FROM pragma_table_info('sector_flow');

SELECT
  'p7_pending_buy_filter_audit_latest_run' AS audit,
  a.run_id,
  r.trade_date,
  r.source_reco_date,
  COUNT(*) AS audit_rows,
  SUM(CASE WHEN a.action = 'SOFT_DOWNGRADE_DEBATE_REQUIRED' THEN 1 ELSE 0 END) AS soft_rrg_rows,
  SUM(CASE WHEN a.reason_code = 'RRG_LAGGING_SOFT_RISK' THEN 1 ELSE 0 END) AS lagging_soft_rows,
  SUM(CASE WHEN a.reason_code = 'RRG_WEAKENING_DOWNGRADE' THEN 1 ELSE 0 END) AS weakening_soft_rows,
  SUM(CASE WHEN a.action LIKE '%REJECT%' THEN 1 ELSE 0 END) AS reject_action_rows,
  MIN(a.created_at) AS first_audit_at,
  MAX(a.created_at) AS last_audit_at
FROM pending_buy_runs r
LEFT JOIN pending_buy_filter_audit a ON a.run_id = r.id
WHERE r.id = (SELECT MAX(id) FROM pending_buy_runs)
GROUP BY a.run_id, r.trade_date, r.source_reco_date;

SELECT
  'p7_rrg_latest_rs_snapshot' AS audit,
  date,
  COUNT(*) AS rs_rows,
  SUM(CASE WHEN quadrant IS NOT NULL THEN 1 ELSE 0 END) AS quadrant_rows,
  SUM(CASE WHEN rs_momentum IS NULL AND quadrant IS NOT NULL THEN 1 ELSE 0 END) AS missing_momentum_classified_rows,
  SUM(CASE WHEN quadrant = 'Leading' THEN 1 ELSE 0 END) AS leading_rows,
  SUM(CASE WHEN quadrant = 'Improving' THEN 1 ELSE 0 END) AS improving_rows,
  SUM(CASE WHEN quadrant = 'Weakening' THEN 1 ELSE 0 END) AS weakening_rows,
  SUM(CASE WHEN quadrant = 'Lagging' THEN 1 ELSE 0 END) AS lagging_rows
FROM sector_flow
WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
  AND rs_ratio IS NOT NULL
  AND date = (
    SELECT MAX(date)
    FROM sector_flow
    WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
      AND rs_ratio IS NOT NULL
  )
GROUP BY date;

SELECT
  'p7_rrg_rotation_model_latest_snapshot' AS audit,
  date,
  COUNT(*) AS rs_rows,
  SUM(CASE WHEN rotation_score IS NOT NULL THEN 1 ELSE 0 END) AS rotation_score_rows,
  SUM(CASE WHEN rotation_regime IS NOT NULL THEN 1 ELSE 0 END) AS rotation_regime_rows,
  SUM(CASE WHEN transition_path IS NOT NULL THEN 1 ELSE 0 END) AS transition_path_rows,
  SUM(CASE WHEN quadrant_age IS NOT NULL THEN 1 ELSE 0 END) AS quadrant_age_rows,
  SUM(CASE WHEN rotation_velocity IS NOT NULL THEN 1 ELSE 0 END) AS rotation_velocity_rows,
  SUM(CASE WHEN rotation_acceleration IS NOT NULL THEN 1 ELSE 0 END) AS rotation_acceleration_rows,
  SUM(CASE WHEN rotation_hysteresis IS NOT NULL THEN 1 ELSE 0 END) AS rotation_hysteresis_rows,
  SUM(CASE WHEN rotation_window >= 2 THEN 1 ELSE 0 END) AS rotation_window_ge2_rows,
  SUM(CASE WHEN json_valid(rrg_tail_json) THEN 1 ELSE 0 END) AS valid_tail_json_rows
FROM sector_flow
WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
  AND rs_ratio IS NOT NULL
  AND rs_momentum IS NOT NULL
  AND quadrant IS NOT NULL
  AND date = (
    SELECT MAX(date)
    FROM sector_flow
    WHERE classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
      AND rs_ratio IS NOT NULL
  )
GROUP BY date;

SELECT
  'p7_formal137_missing_feature_refs_latest_recommendations' AS audit,
  date,
  COUNT(*) AS recommendation_rows,
  SUM(CASE WHEN watch_points LIKE '%alpha_miner_pymoo_nsga3_novelty_0081%' THEN 1 ELSE 0 END) AS rows_with_0081_missing_refs,
  SUM(CASE WHEN watch_points LIKE '%alpha_miner_pymoo_nsga3_novelty_0193%' THEN 1 ELSE 0 END) AS rows_with_0193_missing_refs,
  SUM(CASE WHEN watch_points LIKE '%formal137MarginBalanceRank%' OR watch_points LIKE '%margin_balance_rank%' THEN 1 ELSE 0 END) AS rows_mentioning_margin_rank_gap,
  SUM(CASE WHEN watch_points LIKE '%formal137UsSentimentScoreRank%' OR watch_points LIKE '%us_sentiment_score_rank%' THEN 1 ELSE 0 END) AS rows_mentioning_us_sentiment_rank_gap
FROM daily_recommendations
WHERE date = (SELECT MAX(date) FROM daily_recommendations)
GROUP BY date;

SELECT
  'p7_timesfm_sidecar_latest_ensemble' AS audit,
  prediction_date,
  COUNT(*) AS ensemble_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.timesfm_sidecar.schema_version') = 'timesfm-l1-75-sidecar-v1' THEN 1 ELSE 0 END) AS sidecar_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.timesfm_sidecar.direct_alpha_blocked') = 1 THEN 1 ELSE 0 END) AS direct_alpha_blocked_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.timesfm_sidecar.l2_feature_input_active') = 1 THEN 1 ELSE 0 END) AS timesfm_l2_feature_input_active_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.timesfm_sidecar.l2_feature_input_blocked_reason') = 'requires_formal137_registry_retrain_release' THEN 1 ELSE 0 END) AS timesfm_l2_blocked_reason_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.ensemble_v2.weights.TimesFM') IS NOT NULL THEN 1 ELSE 0 END) AS timesfm_direct_weight_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.timesfm.forecast_pct') IS NOT NULL THEN 1 ELSE 0 END) AS raw_timesfm_rows
FROM predictions
WHERE model_name = 'ensemble'
  AND prediction_date = (
    SELECT MAX(prediction_date)
    FROM predictions
    WHERE model_name = 'ensemble'
      AND prediction_date IS NOT NULL
  )
GROUP BY prediction_date;
