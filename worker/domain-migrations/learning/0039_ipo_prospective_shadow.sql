-- Observation only. No FK/head referencing serving or model promotion pointers.
CREATE TABLE IF NOT EXISTS ipo_shadow_candidates_v1 (
  candidate_id TEXT PRIMARY KEY, registered_at TEXT NOT NULL,
  model_json TEXT NOT NULL CHECK(json_valid(model_json)), model_checksum TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ipo_shadow_predictions_v1 (
  candidate_id TEXT NOT NULL, signal_date TEXT NOT NULL, stock_id INTEGER NOT NULL,
  symbol TEXT NOT NULL, frozen_at TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  input_checksum TEXT NOT NULL, ipo_ev REAL NOT NULL, l4_ev REAL, l4_artifact TEXT,
  PRIMARY KEY(candidate_id,signal_date,stock_id)
);
CREATE TABLE IF NOT EXISTS ipo_shadow_batches_v1 (
  candidate_id TEXT NOT NULL, signal_date TEXT NOT NULL, source_run_id TEXT NOT NULL,
  frozen_at TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count>0), input_checksum TEXT NOT NULL,
  PRIMARY KEY(candidate_id,signal_date)
);
CREATE TABLE IF NOT EXISTS ipo_shadow_daily_evaluations_v1 (
  evaluation_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, signal_date TEXT NOT NULL,
  business_date TEXT NOT NULL, evaluator_version TEXT NOT NULL, labels_checksum TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)), evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ipo_shadow_evaluations_date
  ON ipo_shadow_daily_evaluations_v1(candidate_id,signal_date,evaluated_at DESC);
CREATE TRIGGER IF NOT EXISTS ipo_candidate_immutable BEFORE UPDATE ON ipo_shadow_candidates_v1
BEGIN SELECT RAISE(ABORT,'ipo_candidate_immutable'); END;
CREATE TRIGGER IF NOT EXISTS ipo_prediction_immutable BEFORE UPDATE ON ipo_shadow_predictions_v1
BEGIN SELECT RAISE(ABORT,'ipo_prediction_immutable'); END;
CREATE TRIGGER IF NOT EXISTS ipo_batch_immutable BEFORE UPDATE ON ipo_shadow_batches_v1
BEGIN SELECT RAISE(ABORT,'ipo_batch_immutable'); END;
CREATE TRIGGER IF NOT EXISTS ipo_evaluation_immutable BEFORE UPDATE ON ipo_shadow_daily_evaluations_v1
BEGIN SELECT RAISE(ABORT,'ipo_evaluation_immutable'); END;
