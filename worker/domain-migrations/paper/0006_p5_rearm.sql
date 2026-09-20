-- Explicit incident recovery only. Historical orders and NAV are never reset.
CREATE TABLE IF NOT EXISTS paper_p5_rearms_v1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL REFERENCES paper_accounts(id),
  cutoff_sell_id INTEGER NOT NULL CHECK(cutoff_sell_id > 0),
  last_order_id INTEGER NOT NULL CHECK(last_order_id >= cutoff_sell_id),
  previous_rearm_id INTEGER NOT NULL CHECK(previous_rearm_id >= 0),
  incident_ref TEXT NOT NULL,
  repair_version TEXT NOT NULL,
  validation_ref TEXT NOT NULL,
  validation_sha256 TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, cutoff_sell_id)
);
CREATE INDEX IF NOT EXISTS idx_p5_rearms_account ON paper_p5_rearms_v1(account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_account_side_id ON paper_orders(account_id, side, id DESC);
CREATE TRIGGER IF NOT EXISTS p5_rearms_no_update BEFORE UPDATE ON paper_p5_rearms_v1
BEGIN SELECT RAISE(ABORT, 'p5_rearm_audit_is_append_only'); END;
CREATE TRIGGER IF NOT EXISTS p5_rearms_no_delete BEFORE DELETE ON paper_p5_rearms_v1
BEGIN SELECT RAISE(ABORT, 'p5_rearm_audit_is_append_only'); END;
