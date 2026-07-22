-- Cross-D1 changes use an outbox/inbox projection. Cross-database joins and
-- best-effort dual writes are intentionally not part of the contract.

CREATE TABLE IF NOT EXISTS domain_projection_outbox (
  event_id TEXT PRIMARY KEY,
  source_domain TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  business_date TEXT,
  payload_json TEXT,
  payload_artifact_id TEXT,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'publishing', 'published', 'error')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_domain_projection_outbox_pending
  ON domain_projection_outbox(status, available_at, source_domain, target_domain);

CREATE TABLE IF NOT EXISTS domain_projection_inbox (
  target_domain TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(target_domain, event_id)
);

CREATE TABLE IF NOT EXISTS data_domain_cutovers (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('legacy', 'shadow', 'read_cutover', 'write_cutover', 'complete', 'rollback')),
  source_binding TEXT NOT NULL DEFAULT 'DB',
  target_binding TEXT,
  source_row_count INTEGER,
  target_row_count INTEGER,
  source_checksum TEXT,
  target_checksum TEXT,
  parity_checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
