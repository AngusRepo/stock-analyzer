-- P0-P3 production preflight audit, read-only.
-- Do not put mutation statements in this file.
--
-- Remote D1 note:
--   Do not run this read-only audit with `--remote --file`; Wrangler treats
--   remote files as imports. Use the SELECT statements below with `--command`,
--   or run the file only against a local/exported mirror.
--
-- Companion read-only KV checks:
--   npx wrangler@4 kv key get --namespace-id 39dcebcf5b6848c98f269ef9a48dc3f8 "optimizer:ga:latest"
--   npx wrangler@4 kv key get --namespace-id 39dcebcf5b6848c98f269ef9a48dc3f8 "ml:adaptive_params"
--   npx wrangler@4 kv key list --namespace-id 39dcebcf5b6848c98f269ef9a48dc3f8 --prefix "optimizer:ga:"
--   npx wrangler@4 kv key list --namespace-id 39dcebcf5b6848c98f269ef9a48dc3f8 --prefix "ml:"

SELECT
  'p0_direction_correct_minus_one_scope' AS audit,
  COUNT(*) AS total_minus_one,
  SUM(CASE
    WHEN LOWER(COALESCE(actual_direction, '')) = 'neutral'
      OR LOWER(COALESCE(predicted_direction, '')) = 'neutral'
      OR LOWER(COALESCE(trade_signal, '')) = 'hold'
      OR (predicted_direction IS NULL AND actual_direction IS NULL AND trade_signal IS NULL)
    THEN 1 ELSE 0
  END) AS skipped_safe_null_scope,
  SUM(CASE
    WHEN NOT (
      LOWER(COALESCE(actual_direction, '')) = 'neutral'
      OR LOWER(COALESCE(predicted_direction, '')) = 'neutral'
      OR LOWER(COALESCE(trade_signal, '')) = 'hold'
      OR (predicted_direction IS NULL AND actual_direction IS NULL AND trade_signal IS NULL)
    )
    THEN 1 ELSE 0
  END) AS residual_outside_scope,
  MIN(prediction_date) AS first_date,
  MAX(prediction_date) AS last_date
FROM predictions
WHERE direction_correct = -1;

SELECT
  'p0_direction_correct_minus_one_by_state' AS audit,
  COALESCE(model_name, '<NULL>') AS model_name,
  COALESCE(predicted_direction, '<NULL>') AS predicted_direction,
  COALESCE(actual_direction, '<NULL>') AS actual_direction,
  COALESCE(trade_signal, '<NULL>') AS trade_signal,
  COUNT(*) AS row_count,
  MIN(prediction_date) AS first_date,
  MAX(prediction_date) AS last_date
FROM predictions
WHERE direction_correct = -1
GROUP BY
  COALESCE(model_name, '<NULL>'),
  COALESCE(predicted_direction, '<NULL>'),
  COALESCE(actual_direction, '<NULL>'),
  COALESCE(trade_signal, '<NULL>')
ORDER BY row_count DESC
LIMIT 40;

SELECT
  'p1_timesfm_sidecar_presence' AS audit,
  COUNT(*) AS ensemble_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.timesfm_sidecar.schema_version') IS NOT NULL THEN 1 ELSE 0 END) AS timesfm_sidecar_rows,
  SUM(CASE WHEN json_extract(forecast_data, '$.timesfm.forecast_pct') IS NOT NULL THEN 1 ELSE 0 END) AS raw_timesfm_rows,
  MIN(prediction_date) AS first_date,
  MAX(prediction_date) AS last_date
FROM predictions
WHERE model_name = 'ensemble';

SELECT
  'p1_timesfm_model_rows' AS audit,
  model_name,
  COUNT(*) AS rows,
  SUM(CASE WHEN actual_return_pct IS NOT NULL THEN 1 ELSE 0 END) AS verified_rows,
  AVG(CASE WHEN direction_correct IN (0, 1) THEN direction_correct ELSE NULL END) AS binary_accuracy,
  SUM(CASE WHEN direction_correct = -1 THEN 1 ELSE 0 END) AS minus_one_rows,
  MIN(prediction_date) AS first_date,
  MAX(prediction_date) AS last_date
FROM predictions
WHERE model_name = 'TimesFM'
GROUP BY model_name;

SELECT
  'p2_ga_registry_status' AS audit,
  source,
  status,
  COUNT(*) AS row_count,
  MIN(updated_at) AS first_updated,
  MAX(updated_at) AS last_updated
FROM parameter_candidate_registry
GROUP BY source, status
ORDER BY source, status;

SELECT
  'p2_ga_latest_candidates' AS audit,
  candidate_id,
  status,
  promotion_packet_id,
  run_id,
  cadence,
  updated_at,
  substr(metadata_json, 1, 500) AS metadata_sample,
  substr(latest_evidence_json, 1, 500) AS evidence_sample
FROM parameter_candidate_registry
WHERE source = 'ga_optimizer'
ORDER BY updated_at DESC
LIMIT 8;

SELECT
  'p2_ga_evidence_status' AS audit,
  evidence_type,
  decision,
  COUNT(*) AS row_count,
  SUM(CASE WHEN promotion_packet_id IS NOT NULL THEN 1 ELSE 0 END) AS with_promotion_packet,
  MIN(created_at) AS first_created,
  MAX(created_at) AS last_created
FROM parameter_candidate_evidence
WHERE candidate_id LIKE 'parameter:ga_optimizer:%'
   OR candidate_id LIKE 'ga_optimizer:%'
GROUP BY evidence_type, decision
ORDER BY last_created DESC;
