CREATE TABLE IF NOT EXISTS strategy_marginal_edge_runs_v4 (
  run_id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('shadow','promoted','failed')),
  strategy_count INTEGER NOT NULL,
  eligible_strategy_count INTEGER NOT NULL,
  sample_dates INTEGER NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_strategy_marginal_edge_runs_v4_date
  ON strategy_marginal_edge_runs_v4(as_of_date DESC, status, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_marginal_edge_v4 (
  run_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  edge_schema_version TEXT NOT NULL DEFAULT 'strategy-marginal-edge-v4',
  observation_dates INTEGER NOT NULL,
  candidate_observations INTEGER NOT NULL,
  marginal_edge_mean REAL,
  marginal_edge_lcb90 REAL,
  positive_date_rate REAL,
  absolute_hit_return_mean REAL,
  production_eligible INTEGER NOT NULL DEFAULT 0 CHECK(production_eligible IN (0,1)),
  production_weight_raw REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, strategy_id, strategy_version),
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);
CREATE INDEX IF NOT EXISTS idx_strategy_marginal_edge_v4_latest
  ON strategy_marginal_edge_v4(as_of_date DESC, production_eligible, strategy_id);

CREATE TABLE IF NOT EXISTS strategy_marginal_edge_dates_v4 (
  run_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  candidate_residual_return REAL,
  candidate_absolute_return REAL,
  champion_residual_return REAL,
  champion_absolute_return REAL,
  paired_residual_delta REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, signal_date),
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);
CREATE INDEX IF NOT EXISTS idx_strategy_marginal_edge_dates_v4_date
  ON strategy_marginal_edge_dates_v4(signal_date, run_id);

CREATE TABLE IF NOT EXISTS strategy_marginal_edge_head_v4 (
  owner_key TEXT PRIMARY KEY CHECK(owner_key = 'production'),
  run_id TEXT NOT NULL,
  previous_run_id TEXT,
  promoted_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);
