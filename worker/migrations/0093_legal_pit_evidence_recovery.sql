-- Preserve exact taxonomy membership used by sector-flow and make historical
-- route reconstruction eligibility explicit. Existing sector_flow rows are
-- not relabeled; only future native runs or verified immutable imports may
-- create taxonomy snapshots.

CREATE TABLE IF NOT EXISTS sector_taxonomy_membership_snapshots_v1 (
  snapshot_date TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  tag_type TEXT NOT NULL,
  tag TEXT NOT NULL,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL,
  source_as_of_date TEXT NOT NULL,
  source_lineage_json TEXT,
  membership_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(snapshot_date, tag_type, tag, symbol)
);
CREATE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_v1_date_type
  ON sector_taxonomy_membership_snapshots_v1(snapshot_date, tag_type, tag);
CREATE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_v1_id
  ON sector_taxonomy_membership_snapshots_v1(snapshot_id, membership_checksum);

CREATE TABLE IF NOT EXISTS sector_taxonomy_snapshot_runs_v1 (
  snapshot_date TEXT NOT NULL,
  tag_type TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  membership_checksum TEXT NOT NULL,
  expected_row_count INTEGER NOT NULL,
  persisted_row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('writing', 'ready', 'failed')),
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(snapshot_date, tag_type)
);
CREATE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_runs_v1_status
  ON sector_taxonomy_snapshot_runs_v1(status, snapshot_date, tag_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_runs_v1_id
  ON sector_taxonomy_snapshot_runs_v1(snapshot_id);

ALTER TABLE sector_flow ADD COLUMN taxonomy_snapshot_id TEXT;
ALTER TABLE sector_flow ADD COLUMN taxonomy_membership_checksum TEXT;
ALTER TABLE sector_flow ADD COLUMN knowledge_cutoff_date TEXT;
ALTER TABLE sector_flow ADD COLUMN reconstruction_mode TEXT;

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

CREATE TABLE IF NOT EXISTS strategy_route_backfill_eligibility_v1 (
  signal_date TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('eligible', 'unavailable', 'pending_maturity')),
  reference_rows INTEGER NOT NULL,
  mature_label_rows INTEGER NOT NULL,
  matrix_rows INTEGER NOT NULL,
  evaluable_matrix_rows INTEGER NOT NULL,
  challenger_affinity_rows INTEGER NOT NULL,
  threshold_margin_rows INTEGER NOT NULL,
  challenger_route_rows INTEGER NOT NULL,
  blocker_json TEXT NOT NULL,
  audited_as_of_date TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, producer_run_id)
);
CREATE INDEX IF NOT EXISTS idx_strategy_route_backfill_eligibility_v1_status
  ON strategy_route_backfill_eligibility_v1(status, signal_date);
