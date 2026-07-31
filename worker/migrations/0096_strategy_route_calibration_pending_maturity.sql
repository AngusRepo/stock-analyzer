-- Preserve route-calibration candidates while making maturity an explicit lifecycle state.
DROP INDEX IF EXISTS idx_strategy_route_calibration_runs_v1_date;

ALTER TABLE strategy_route_calibration_head_v1
  RENAME TO strategy_route_calibration_head_v1_legacy_0096;

ALTER TABLE strategy_route_calibration_runs_v1
  RENAME TO strategy_route_calibration_runs_v1_legacy_0096;

CREATE TABLE strategy_route_calibration_runs_v1 (
  run_id TEXT PRIMARY KEY,
  artifact_version TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'pending_maturity', 'pass', 'fail', 'promoted')),
  candidate_route_version TEXT NOT NULL,
  route_floor REAL,
  sample_count INTEGER NOT NULL,
  date_count INTEGER NOT NULL,
  train_start_date TEXT,
  train_end_date TEXT,
  oos_start_date TEXT,
  oos_end_date TEXT,
  top_bucket_net_return REAL,
  top_bucket_net_return_lcb90 REAL,
  residual_spread REAL,
  residual_spread_lcb90 REAL,
  brier_score REAL,
  climatology_brier_score REAL,
  log_loss REAL,
  gate_json TEXT NOT NULL,
  evidence_artifact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO strategy_route_calibration_runs_v1 (
  run_id, artifact_version, as_of_date, status, candidate_route_version,
  route_floor, sample_count, date_count, train_start_date, train_end_date,
  oos_start_date, oos_end_date, top_bucket_net_return,
  top_bucket_net_return_lcb90, residual_spread, residual_spread_lcb90,
  brier_score, climatology_brier_score, log_loss, gate_json,
  evidence_artifact_id, created_at
)
SELECT
  run_id, artifact_version, as_of_date, status, candidate_route_version,
  route_floor, sample_count, date_count, train_start_date, train_end_date,
  oos_start_date, oos_end_date, top_bucket_net_return,
  top_bucket_net_return_lcb90, residual_spread, residual_spread_lcb90,
  brier_score, climatology_brier_score, log_loss, gate_json,
  evidence_artifact_id, created_at
FROM strategy_route_calibration_runs_v1_legacy_0096;

CREATE TABLE strategy_route_calibration_head_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  run_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  candidate_route_version TEXT NOT NULL,
  route_floor REAL NOT NULL,
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES strategy_route_calibration_runs_v1(run_id)
);

INSERT INTO strategy_route_calibration_head_v1 (
  singleton_id, run_id, artifact_version, candidate_route_version,
  route_floor, promoted_at
)
SELECT
  singleton_id, run_id, artifact_version, candidate_route_version,
  route_floor, promoted_at
FROM strategy_route_calibration_head_v1_legacy_0096;

DROP TABLE strategy_route_calibration_head_v1_legacy_0096;
DROP TABLE strategy_route_calibration_runs_v1_legacy_0096;

CREATE INDEX idx_strategy_route_calibration_runs_v1_date
  ON strategy_route_calibration_runs_v1(as_of_date DESC, status, created_at DESC);
