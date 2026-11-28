-- dataset-snapshot-export reads every verified prediction of its 1280-day window through
-- load_verified_predictions (ml-controller/services/backtest_state.py):
--   SELECT id, generated_at, direction_correct, verified_at, verification_label_known_date
--   FROM predictions WHERE generated_at BETWEEN ? AND ? AND direction_correct IN (0, 1)
--   ORDER BY generated_at ASC
-- No predictions index starts with generated_at, so it was SCAN predictions plus a TEMP B-TREE
-- sort: every row (~395k on 2026-11-26), including the overflow pages of forecast_data that
-- precede the selected columns, 14-19 s per run; the export's next Learning reads then met
-- D1 overload (7429). This partial index holds only resolved rows and every selected column
-- (id is the rowid), so the read seeks it in generated_at order and never touches the table.
-- The WHERE clause repeats the query's `direction_correct IN (0, 1)`, which SQLite needs to
-- use a partial index. A row enters it when verification writes direction_correct 0/1.
-- Size: at most one entry per resolved prediction, ~65 B each (generated_at 19 B,
-- direction_correct, verified_at ~19-25 B, verification_label_known_date 10 B, rowid, header):
-- under 26 MB even if all ~395k rows were resolved.
-- Not applied by this change: apply with the normal learning migration flow after review.
-- Rollback: DROP INDEX IF EXISTS idx_pred_verified_generated;
CREATE INDEX IF NOT EXISTS idx_pred_verified_generated
  ON predictions(generated_at, direction_correct, verified_at, verification_label_known_date)
  WHERE direction_correct IN (0, 1);
