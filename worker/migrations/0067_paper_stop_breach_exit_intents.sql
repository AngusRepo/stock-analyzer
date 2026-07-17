-- Tick-level stop breaches are immutable facts. Trigger state is persisted
-- separately from executable-book matching so a V-shaped rebound cannot
-- restore HOLD after the stop was touched.
CREATE TABLE IF NOT EXISTS paper_exit_intents (
  intent_key TEXT NOT NULL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entry_date TEXT,
  requested_shares INTEGER NOT NULL,
  remaining_shares INTEGER NOT NULL,
  stop_price REAL NOT NULL,
  stop_version TEXT NOT NULL,
  trigger_price REAL NOT NULL,
  trigger_time TEXT,
  received_at TEXT NOT NULL,
  session_epoch INTEGER,
  trigger_source TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'EXIT_TRIGGERED_WAITING_BOOK'
    CHECK (state IN (
      'EXIT_TRIGGERED_WAITING_BOOK',
      'SUBMITTING',
      'PARTIAL',
      'FILLED',
      'CANCELLED',
      'SUPERSEDED'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  resolution_order_id INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_exit_intents_active_symbol
  ON paper_exit_intents(account_id, symbol, entry_date, state, created_at);

CREATE INDEX IF NOT EXISTS idx_paper_exit_intents_retry
  ON paper_exit_intents(state, next_attempt_at, updated_at);
