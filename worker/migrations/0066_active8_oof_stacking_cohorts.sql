-- Immutable Active-8 purged walk-forward cohorts. OOF rows are isolated from
-- production-native snapshots so historical reconstruction cannot overwrite or
-- masquerade as a native serving lineage.

ALTER TABLE allocator_ev_feature_snapshots ADD COLUMN lineage_cohort_id TEXT;
ALTER TABLE allocator_ev_feature_snapshots ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'native';
ALTER TABLE allocator_ev_feature_snapshots ADD COLUMN model_set_signature TEXT;
ALTER TABLE allocator_ev_feature_snapshots ADD COLUMN target_semantic_version TEXT;

ALTER TABLE allocator_ev_feature_snapshot_staging ADD COLUMN lineage_cohort_id TEXT;
ALTER TABLE allocator_ev_feature_snapshot_staging ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'native';
ALTER TABLE allocator_ev_feature_snapshot_staging ADD COLUMN model_set_signature TEXT;
ALTER TABLE allocator_ev_feature_snapshot_staging ADD COLUMN target_semantic_version TEXT;

CREATE TABLE IF NOT EXISTS active8_oof_cohorts (
  cohort_id TEXT PRIMARY KEY,
  generation_mode TEXT NOT NULL CHECK(generation_mode = 'purged_oof'),
  status TEXT NOT NULL CHECK(status IN ('building','ready','failed','retired')),
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  model_set_signature TEXT NOT NULL,
  expected_models INTEGER NOT NULL DEFAULT 8,
  expected_folds INTEGER NOT NULL,
  completed_folds INTEGER NOT NULL DEFAULT 0,
  prediction_rows INTEGER NOT NULL DEFAULT 0,
  prediction_dates INTEGER NOT NULL DEFAULT 0,
  artifact_manifest_path TEXT,
  artifact_manifest_checksum TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active8_oof_predictions (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  stock_id INTEGER,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  model_name TEXT NOT NULL,
  raw_score REAL NOT NULL,
  rank_score REAL NOT NULL CHECK(rank_score >= 0.0 AND rank_score <= 1.0),
  target_return REAL NOT NULL,
  label_known_date TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  train_start TEXT NOT NULL,
  train_end TEXT NOT NULL,
  test_start TEXT NOT NULL,
  test_end TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, prediction_date, symbol, market_segment, model_name),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(label_known_date > prediction_date)
);
CREATE INDEX IF NOT EXISTS idx_active8_oof_predictions_cohort_date
  ON active8_oof_predictions(cohort_id, prediction_date, model_name);

CREATE TABLE IF NOT EXISTS allocator_ev_oof_snapshots (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  stock_id INTEGER,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  forecast_data TEXT NOT NULL,
  score REAL,
  score_components TEXT,
  alpha_context TEXT,
  alpha_allocation TEXT NOT NULL,
  market_heat_expected_return REAL,
  recommendation_lane TEXT,
  l4_model_version TEXT,
  s12_source TEXT,
  s12_asof_date TEXT NOT NULL,
  label_known_date TEXT NOT NULL,
  model_set_signature TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  generation_mode TEXT NOT NULL CHECK(generation_mode = 'purged_oof'),
  source_manifest_checksum TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, snapshot_date, symbol, market_segment),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(s12_asof_date <= snapshot_date),
  CHECK(label_known_date > snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_allocator_ev_oof_snapshots_cohort_date
  ON allocator_ev_oof_snapshots(cohort_id, snapshot_date);

CREATE TABLE IF NOT EXISTS l4_oof_predictions (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  expected_return REAL NOT NULL,
  prediction_json TEXT NOT NULL,
  trained_until TEXT NOT NULL,
  model_version TEXT NOT NULL,
  eligible_for_efficacy INTEGER NOT NULL CHECK(eligible_for_efficacy IN (0, 1)),
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, prediction_date, symbol, market_segment),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(trained_until < prediction_date)
);
CREATE INDEX IF NOT EXISTS idx_l4_oof_predictions_cohort_date
  ON l4_oof_predictions(cohort_id, prediction_date);
