CREATE TABLE IF NOT EXISTS data_domain_cutover_probe_receipts (
  receipt_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  source_epoch INTEGER NOT NULL CHECK(source_epoch >= 0),
  parity_checked_at TEXT NOT NULL,
  read_write_readback_passed INTEGER NOT NULL CHECK(read_write_readback_passed IN (0, 1)),
  rollback_restore_passed INTEGER NOT NULL CHECK(rollback_restore_passed IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed')),
  checked_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_data_domain_cutover_probe_latest
  ON data_domain_cutover_probe_receipts(domain, checked_at DESC);

CREATE TABLE IF NOT EXISTS data_domain_cutover_probe_canary (
  probe_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
