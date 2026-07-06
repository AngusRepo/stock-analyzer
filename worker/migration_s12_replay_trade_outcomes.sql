CREATE TABLE IF NOT EXISTS s12_replay_trade_outcomes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                TEXT NOT NULL,
  market                TEXT,
  trade_date            TEXT NOT NULL,
  assessment_state      TEXT,
  setup_id              TEXT,
  entry_ms              INTEGER,
  exit_ms               INTEGER,
  entry_price           REAL,
  stop_price            REAL,
  target1_price         REAL,
  target2_price         REAL,
  target3_price         REAL,
  exit_price            REAL,
  pnl_pct               REAL,
  trade_pnl_r           REAL,
  max_favorable_pct     REAL,
  max_adverse_pct       REAL,
  bars_to_exit          INTEGER,
  exit_reason           TEXT,
  sample_eligible       INTEGER NOT NULL DEFAULT 0,
  source                TEXT NOT NULL DEFAULT 's12_intraday_structure_replay_v1',
  detail_json           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, trade_date, setup_id)
);

CREATE INDEX IF NOT EXISTS idx_s12_replay_trade_outcomes_date
  ON s12_replay_trade_outcomes(trade_date DESC, sample_eligible, symbol);
