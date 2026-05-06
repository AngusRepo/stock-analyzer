CREATE TABLE IF NOT EXISTS stock_trading_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  restriction_type TEXT NOT NULL DEFAULT 'punished',
  source TEXT NOT NULL DEFAULT 'twse',
  reason TEXT,
  start_date TEXT,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_trading_restrictions_active_symbol
  ON stock_trading_restrictions(active, symbol);

CREATE INDEX IF NOT EXISTS idx_stock_trading_restrictions_dates
  ON stock_trading_restrictions(start_date, end_date);
