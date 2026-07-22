-- Durable control-plane state for idempotent daily stages and bounded D1 maintenance.
-- Keep these tables small: do not add indexes to existing large evidence tables until
-- archive/compaction has released production capacity.

CREATE TABLE IF NOT EXISTS pipeline_stage_runs (
  business_date TEXT NOT NULL,
  stage TEXT NOT NULL,
  canonical_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'success', 'error')),
  cursor_key TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  expected_count INTEGER,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(business_date, stage)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage_runs_status
  ON pipeline_stage_runs(stage, status, business_date DESC);

CREATE TABLE IF NOT EXISTS strategy_learning_runs (
  business_date TEXT PRIMARY KEY,
  canonical_run_id TEXT NOT NULL,
  producer_run_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'success', 'error')),
  cursor_symbol TEXT,
  expected_candidates INTEGER,
  processed_candidates INTEGER NOT NULL DEFAULT 0,
  strategy_count INTEGER,
  expected_decision_rows INTEGER,
  persisted_decision_rows INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_strategy_learning_runs_status
  ON strategy_learning_runs(status, business_date DESC);

CREATE TABLE IF NOT EXISTS maintenance_task_leases (
  lease_group TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS legacy_migration_cursors (
  task_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'error')),
  cursor_date TEXT,
  cursor_key TEXT,
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
