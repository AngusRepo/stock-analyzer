-- P3 execution audit source of truth.
-- Run with:
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./worker/migration_paper_execution_events.sql

CREATE TABLE IF NOT EXISTS paper_execution_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL DEFAULT 1,
  trade_date      TEXT NOT NULL,
  symbol          TEXT,
  side            TEXT,
  event_type      TEXT NOT NULL, -- pending_buy | paper_order | debate | snapshot_audit
  status          TEXT NOT NULL,
  reason          TEXT,
  detail_json     TEXT,
  order_id        INTEGER,
  pending_run_id  INTEGER,
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_date
  ON paper_execution_events(trade_date DESC, event_type, status);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_symbol
  ON paper_execution_events(symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_execution_events_order
  ON paper_execution_events(order_id);
