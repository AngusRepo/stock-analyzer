-- Frozen GA challenger versus the production configuration captured at enrollment.
-- This lane is prospective, read-only with respect to trading, and Learning D1-owned.

CREATE TABLE IF NOT EXISTS ga_optimizer_shadow_candidates_v1 (
  shadow_id TEXT PRIMARY KEY,
  candidate_registry_id TEXT NOT NULL,
  ga_candidate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','QUEUED','RETIRED','REJECTED','PROMOTION_READY')),
  candidate_config_json TEXT NOT NULL CHECK(json_valid(candidate_config_json)),
  candidate_config_checksum TEXT NOT NULL CHECK(candidate_config_checksum GLOB 'sha256:*' AND length(candidate_config_checksum)=71),
  baseline_config_json TEXT NOT NULL CHECK(json_valid(baseline_config_json)),
  baseline_config_checksum TEXT NOT NULL CHECK(baseline_config_checksum GLOB 'sha256:*' AND length(baseline_config_checksum)=71),
  evaluator_version TEXT NOT NULL,
  enrolled_business_date TEXT NOT NULL,
  enrollment_snapshot_id TEXT,
  enrollment_snapshot_checksum TEXT,
  source_run_id TEXT NOT NULL,
  source_cadence TEXT,
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect=0),
  last_evidence_business_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ga_candidate_id, candidate_config_checksum, baseline_config_checksum, enrolled_business_date, source_run_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_optimizer_shadow_one_active_v1
  ON ga_optimizer_shadow_candidates_v1(status)
  WHERE status='ACTIVE';

CREATE INDEX IF NOT EXISTS idx_ga_optimizer_shadow_candidate_status_v1
  ON ga_optimizer_shadow_candidates_v1(status, created_at DESC);

CREATE TABLE IF NOT EXISTS ga_optimizer_shadow_daily_evidence_v1 (
  evidence_id TEXT PRIMARY KEY,
  shadow_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_checksum TEXT NOT NULL,
  snapshot_business_date TEXT NOT NULL,
  replay_start_date TEXT NOT NULL,
  replay_end_date TEXT NOT NULL,
  candidate_total_return REAL NOT NULL,
  baseline_total_return REAL NOT NULL,
  paired_return_delta REAL NOT NULL,
  candidate_total_trades INTEGER NOT NULL CHECK(candidate_total_trades >= 0),
  baseline_total_trades INTEGER NOT NULL CHECK(baseline_total_trades >= 0),
  candidate_sharpe REAL,
  baseline_sharpe REAL,
  candidate_max_drawdown REAL,
  baseline_max_drawdown REAL,
  walk_forward_pass INTEGER NOT NULL CHECK(walk_forward_pass IN (0,1)),
  gate_decision TEXT NOT NULL CHECK(gate_decision IN ('PASS','FAIL','MISSING')),
  execution_parity_decision TEXT NOT NULL CHECK(execution_parity_decision IN ('PASS','FAIL','MISSING','NOT_APPLICABLE')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  evidence_checksum TEXT NOT NULL CHECK(evidence_checksum GLOB 'sha256:*' AND length(evidence_checksum)=71),
  run_id TEXT NOT NULL,
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect=0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(shadow_id) REFERENCES ga_optimizer_shadow_candidates_v1(shadow_id),
  UNIQUE(shadow_id, business_date),
  UNIQUE(shadow_id, snapshot_business_date)
);

CREATE INDEX IF NOT EXISTS idx_ga_optimizer_shadow_evidence_date_v1
  ON ga_optimizer_shadow_daily_evidence_v1(shadow_id, business_date DESC);

CREATE TABLE IF NOT EXISTS ga_optimizer_shadow_runs_v1 (
  run_id TEXT PRIMARY KEY,
  shadow_id TEXT,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCESS','SKIPPED','ERROR')),
  summary TEXT,
  error TEXT,
  evidence_id TEXT,
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect=0),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ga_optimizer_shadow_runs_date_v1
  ON ga_optimizer_shadow_runs_v1(business_date DESC, updated_at DESC);
