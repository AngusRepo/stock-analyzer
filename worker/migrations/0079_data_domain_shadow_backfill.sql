-- Bounded, resumable cross-D1 shadow copy and parity evidence.
CREATE TABLE IF NOT EXISTS data_domain_backfill_cursors (
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','error')),
  cursor_json TEXT,
  rows_copied INTEGER NOT NULL DEFAULT 0,
  last_batch_rows INTEGER NOT NULL DEFAULT 0,
  last_source_checksum TEXT,
  last_target_checksum TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(domain, table_name)
);
CREATE INDEX IF NOT EXISTS idx_data_domain_backfill_status
  ON data_domain_backfill_cursors(status, domain, updated_at);

CREATE TABLE IF NOT EXISTS data_domain_parity_checks (
  check_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  check_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','blocked')),
  source_count INTEGER,
  target_count INTEGER,
  source_checksum TEXT,
  target_checksum TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_data_domain_parity_latest
  ON data_domain_parity_checks(domain, table_name, checked_at DESC);
