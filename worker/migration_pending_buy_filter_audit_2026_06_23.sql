-- Durable symbol-level Morning Setup filter audit.
-- Run with:
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./worker/migration_pending_buy_filter_audit_2026_06_23.sql

CREATE TABLE IF NOT EXISTS pending_buy_filter_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES pending_buy_runs(id) ON DELETE CASCADE,
  trade_date        TEXT NOT NULL,
  source_reco_date  TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  name              TEXT,
  stage             TEXT NOT NULL,
  action            TEXT NOT NULL,
  reason_code       TEXT NOT NULL,
  theme             TEXT,
  classification    TEXT,
  quadrant          TEXT,
  rs_ratio          REAL,
  rs_momentum       REAL,
  risk_multiplier   REAL,
  details_json      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_buy_filter_audit_run
  ON pending_buy_filter_audit(run_id, stage, action);

CREATE INDEX IF NOT EXISTS idx_pending_buy_filter_audit_trade_date
  ON pending_buy_filter_audit(trade_date DESC, source_reco_date, symbol);

CREATE INDEX IF NOT EXISTS idx_pending_buy_filter_audit_reason
  ON pending_buy_filter_audit(reason_code, trade_date DESC);
