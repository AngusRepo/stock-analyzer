-- Keep the split Ops D1 schema aligned with post-baseline operational tables.
-- This migration is additive and safe to apply to an already populated target.

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

CREATE TABLE IF NOT EXISTS s12_structure_batch_runs (
  run_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('evening_chain','historical_shadow','manual_repair')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  shard_count INTEGER NOT NULL DEFAULT 0,
  completed_shards INTEGER NOT NULL DEFAULT 0,
  artifact_id TEXT,
  artifact_checksum TEXT,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(artifact_checksum IS NULL OR artifact_checksum GLOB 'sha256:[0-9a-f]*')
);
CREATE INDEX IF NOT EXISTS idx_s12_structure_batch_runs_date_status
  ON s12_structure_batch_runs(trade_date DESC, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS s12_structure_batch_shards (
  run_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  first_symbol TEXT,
  last_symbol TEXT,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  attempt INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, shard_index),
  FOREIGN KEY(run_id) REFERENCES s12_structure_batch_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_s12_structure_batch_shards_status
  ON s12_structure_batch_shards(status, updated_at, run_id, shard_index);

CREATE TABLE IF NOT EXISTS sector_flow_pit_rebuild_runs_v1 (
  run_id TEXT PRIMARY KEY,
  signal_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'pass', 'blocked', 'failed')),
  reconstruction_mode TEXT NOT NULL CHECK(reconstruction_mode IN ('native', 'historical_reconstruction')),
  taxonomy_snapshot_ids_json TEXT NOT NULL,
  membership_checksums_json TEXT NOT NULL,
  rows_written INTEGER NOT NULL DEFAULT 0,
  blocker_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sector_flow_pit_rebuild_runs_v1_date
  ON sector_flow_pit_rebuild_runs_v1(signal_date, status, started_at DESC);
