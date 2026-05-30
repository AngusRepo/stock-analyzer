-- Supplemental official/global data: monthly revenue + market breadth + US lead indicators
-- 2026-03-25

CREATE TABLE IF NOT EXISTS monthly_revenue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id    INTEGER NOT NULL REFERENCES stocks(id),
  date        TEXT NOT NULL, -- revenue period, for example 2026-02
  revenue     REAL NOT NULL,
  revenue_yoy REAL,
  revenue_mom REAL,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE INDEX IF NOT EXISTS idx_monthly_revenue_stock_date
  ON monthly_revenue(stock_id, date);

CREATE TABLE IF NOT EXISTS market_breadth (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  date               TEXT NOT NULL UNIQUE,
  advance_count      INTEGER,
  decline_count      INTEGER,
  unchanged_count    INTEGER,
  advance_ratio      REAL,
  bull_alignment_pct REAL,
  new_high_count     INTEGER,
  new_low_count      INTEGER,
  margin_balance     REAL,
  short_balance      REAL,
  margin_maintenance REAL,
  created_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS us_market_signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL UNIQUE,
  sox_close     REAL,
  sox_return    REAL,
  sox_ma5       REAL,
  tsm_close     REAL,
  tsm_return    REAL,
  tsm_premium   REAL,
  gspc_close    REAL,
  gspc_return   REAL,
  dxy_close     REAL,
  dxy_return    REAL,
  hy_spread     REAL,
  hy_spread_chg REAL,
  vix_close     REAL,
  sentiment     TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
