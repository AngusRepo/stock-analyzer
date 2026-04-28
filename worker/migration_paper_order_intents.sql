CREATE TABLE IF NOT EXISTS paper_order_intents (
  intent_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  order_id INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_order_intents_unique
  ON paper_order_intents(account_id, trade_date, symbol, side, source);

CREATE INDEX IF NOT EXISTS idx_paper_order_intents_date
  ON paper_order_intents(trade_date, status);
