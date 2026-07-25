-- Durable, dataset-level progress for recurring retention. A cursor advances
-- only after archive verification and the corresponding D1 mutation succeed.

CREATE TABLE IF NOT EXISTS data_retention_cursors (
  policy_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','cycle_complete','error')),
  cursor_date TEXT,
  cursor_key TEXT,
  cycle INTEGER NOT NULL DEFAULT 0,
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  backlog_remaining INTEGER NOT NULL DEFAULT 1 CHECK(backlog_remaining IN (0,1)),
  last_run_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(policy_id, dataset_id),
  FOREIGN KEY(policy_id) REFERENCES data_retention_policies(policy_id)
);
CREATE INDEX IF NOT EXISTS idx_data_retention_cursors_backlog
  ON data_retention_cursors(status, backlog_remaining, policy_id, updated_at);

CREATE TABLE IF NOT EXISTS data_retention_run_items (
  run_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','error','skipped')),
  scanned_rows INTEGER NOT NULL DEFAULT 0,
  archived_rows INTEGER NOT NULL DEFAULT 0,
  scrubbed_rows INTEGER NOT NULL DEFAULT 0,
  deleted_rows INTEGER NOT NULL DEFAULT 0,
  archived_bytes INTEGER NOT NULL DEFAULT 0,
  cursor_date TEXT,
  cursor_key TEXT,
  backlog_remaining INTEGER NOT NULL DEFAULT 0 CHECK(backlog_remaining IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, dataset_id),
  FOREIGN KEY(run_id) REFERENCES data_retention_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_data_retention_run_items_dataset
  ON data_retention_run_items(dataset_id, completed_at DESC, status);
