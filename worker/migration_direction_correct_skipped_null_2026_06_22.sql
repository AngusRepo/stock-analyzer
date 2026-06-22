-- Manual repair for historical skipped / non-directional verification rows.
-- Do not run without explicit Wei approval.
--
-- Purpose:
--   predictions.direction_correct contract is 1=correct, 0=wrong, NULL=pending/skipped.
--   Older verify_service wrote -1 for HOLD / neutral / malformed skipped rows, which
--   polluted consumers that treated direction_correct IS NOT NULL as a binary label.
--
-- Production read-only preflight on 2026-06-22 showed:
--   total direction_correct=-1 rows: 26,912
--   skipped/non-directional safe null scope: 26,908
--   malformed all-null skipped rows: 4
--
-- Production execution:
--   Do not run this file directly against remote D1. Use the explicit
--   step-by-step approval runbook:
--   worker/runbook_direction_correct_skipped_repair_2026_06_22.md

SELECT
  'audit_all_minus_one_by_prediction_state' AS phase,
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
ORDER BY row_count DESC;

SELECT
  'audit_repair_scope' AS phase,
  COUNT(*) AS row_count
FROM predictions
WHERE direction_correct = -1
  AND (
    LOWER(COALESCE(actual_direction, '')) = 'neutral'
    OR LOWER(COALESCE(predicted_direction, '')) = 'neutral'
    OR LOWER(COALESCE(trade_signal, '')) = 'hold'
    OR (
      predicted_direction IS NULL
      AND actual_direction IS NULL
      AND trade_signal IS NULL
    )
  );

UPDATE predictions
SET direction_correct = NULL
WHERE direction_correct = -1
  AND (
    LOWER(COALESCE(actual_direction, '')) = 'neutral'
    OR LOWER(COALESCE(predicted_direction, '')) = 'neutral'
    OR LOWER(COALESCE(trade_signal, '')) = 'hold'
    OR (
      predicted_direction IS NULL
      AND actual_direction IS NULL
      AND trade_signal IS NULL
    )
  );

SELECT
  'post_repair_remaining_minus_one' AS phase,
  COUNT(*) AS row_count
FROM predictions
WHERE direction_correct = -1;
