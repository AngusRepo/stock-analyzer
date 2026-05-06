-- Durable pending buy pipeline state
-- Run with:
--   npx wrangler@4 d1 execute stockvision-db --remote --file=./worker/migration_pending_buy_runs.sql

CREATE TABLE IF NOT EXISTS pending_buy_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date        TEXT NOT NULL,
  source_reco_date  TEXT,
  status            TEXT NOT NULL DEFAULT 'ready',       -- ready | empty | halted | error | superseded
  debate_status     TEXT NOT NULL DEFAULT 'pending',     -- pending | completed | failed | skipped
  candidate_count   INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_buy_runs_trade_date
  ON pending_buy_runs(trade_date, id DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_runs_status
  ON pending_buy_runs(status, trade_date DESC);

CREATE TABLE IF NOT EXISTS pending_buy_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES pending_buy_runs(id) ON DELETE CASCADE,
  symbol            TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  signal            TEXT NOT NULL DEFAULT 'BUY',
  confidence        REAL NOT NULL DEFAULT 0,
  ml_entry_price    REAL NOT NULL DEFAULT 0,
  ml_stop_loss      REAL,
  ml_target1        REAL,
  ml_target2        REAL,
  reason            TEXT,
  watch_points_json TEXT,
  debate_verdict    TEXT NOT NULL DEFAULT 'PENDING',
  debate_status     TEXT NOT NULL DEFAULT 'pending',
  execution_status  TEXT NOT NULL DEFAULT 'pending',     -- pending | filled | skipped | cancelled | expired
  risk_pct          REAL NOT NULL DEFAULT 0,
  kelly_pct         REAL,
  chip_score        REAL,
  tech_score        REAL,
  ml_score          REAL,
  score             REAL,
  source            TEXT,
  original_entry    REAL,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_run
  ON pending_buy_items(run_id, score DESC, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_symbol
  ON pending_buy_items(symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_buy_items_execution
  ON pending_buy_items(execution_status, debate_status, symbol);
