CREATE TABLE IF NOT EXISTS strategy_evidence_owner_calibration_runs_v1 (
  run_id TEXT PRIMARY KEY,
  artifact_version TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_maturity','rejected','approved','promoted')),
  source_metric_definition_version TEXT NOT NULL,
  source_snapshot_count INTEGER NOT NULL,
  source_snapshot_checksum TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  date_count INTEGER NOT NULL,
  train_dates_json TEXT NOT NULL DEFAULT '[]',
  purge_dates_json TEXT NOT NULL DEFAULT '[]',
  oos_dates_json TEXT NOT NULL DEFAULT '[]',
  baseline_return REAL,
  challenger_return REAL,
  challenger_delta REAL,
  challenger_delta_lcb90 REAL,
  coverage REAL,
  gate_json TEXT NOT NULL DEFAULT '{}',
  artifact_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(json_valid(train_dates_json)),
  CHECK(json_valid(purge_dates_json)),
  CHECK(json_valid(oos_dates_json)),
  CHECK(json_valid(gate_json))
);

CREATE TABLE IF NOT EXISTS strategy_evidence_owner_calibration_artifacts_v1 (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  metric_outcome_as_of_date TEXT NOT NULL,
  multi_horizon_score REAL,
  weight_multiplier REAL NOT NULL,
  source_metric_checksum TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, strategy_id, strategy_version),
  FOREIGN KEY(run_id) REFERENCES strategy_evidence_owner_calibration_runs_v1(run_id)
);

CREATE TABLE IF NOT EXISTS strategy_evidence_owner_calibration_head_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  run_id TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES strategy_evidence_owner_calibration_runs_v1(run_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_owner_calibration_runs_date
  ON strategy_evidence_owner_calibration_runs_v1(knowledge_cutoff_date DESC, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_owner_calibration_artifacts_run
  ON strategy_evidence_owner_calibration_artifacts_v1(run_id, strategy_id, strategy_version);
