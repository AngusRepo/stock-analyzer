-- Durable scalar continuity for current-session S12 minute bars.
-- Full decision/fill evidence remains R2-first; this hot table only keeps the
-- compact OHLCV lineage required to survive Market Data Hub revision restarts.
CREATE TABLE IF NOT EXISTS intraday_minute_bars (
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  minute_start TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  session_epoch INTEGER,
  source_event_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trade_date, symbol, minute_start)
);

CREATE INDEX IF NOT EXISTS idx_intraday_minute_bars_symbol_date
  ON intraday_minute_bars(symbol, trade_date, minute_start);
