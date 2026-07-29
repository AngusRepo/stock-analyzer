-- Preserve the incumbent router while collecting a point-in-time challenger score.
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN strategy_affinity_version TEXT;
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN strategy_router_score REAL;
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN strategy_challenger_affinity_version TEXT;
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN strategy_challenger_route_version TEXT;
ALTER TABLE selection_reference_snapshots_v1 ADD COLUMN strategy_challenger_route_score REAL;

ALTER TABLE strategy_label_matrix_v4 ADD COLUMN affinity_version TEXT;
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN match_strength REAL NOT NULL DEFAULT 0;
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN threshold_margin REAL NOT NULL DEFAULT 0;
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN affinity_evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN challenger_affinity REAL NOT NULL DEFAULT 0;
ALTER TABLE strategy_label_matrix_v4 ADD COLUMN challenger_position_weight REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_selection_reference_route_challenger_v1
  ON selection_reference_snapshots_v1(signal_date, strategy_challenger_route_version, strategy_challenger_route_score);
CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_challenger_v1
  ON strategy_label_matrix_v4(signal_date, strategy_id, evaluable, challenger_affinity);

CREATE TABLE IF NOT EXISTS strategy_route_calibration_runs_v1 (
  run_id TEXT PRIMARY KEY,
  artifact_version TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'pass', 'fail', 'promoted')),
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
CREATE INDEX IF NOT EXISTS idx_strategy_route_calibration_runs_v1_date
  ON strategy_route_calibration_runs_v1(as_of_date DESC, status, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_route_calibration_head_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  run_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  candidate_route_version TEXT NOT NULL,
  route_floor REAL NOT NULL,
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES strategy_route_calibration_runs_v1(run_id)
);

CREATE TABLE IF NOT EXISTS strategy_redundancy_artifacts_v1 (
  artifact_id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'pass', 'fail')),
  source_contract TEXT NOT NULL,
  strategy_count INTEGER NOT NULL,
  paired_date_count INTEGER NOT NULL,
  oof_max_date TEXT,
  edge_count INTEGER NOT NULL,
  effective_strategy_count REAL,
  graph_json TEXT NOT NULL,
  evidence_artifact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_strategy_redundancy_artifacts_v1_date
  ON strategy_redundancy_artifacts_v1(as_of_date DESC, status, created_at DESC);
