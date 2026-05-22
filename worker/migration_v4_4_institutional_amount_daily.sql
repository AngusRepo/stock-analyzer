-- V4.4 canonical market-level institutional amount closure.
-- Source: FinLab institutional_investors_trading_all_market_summary.

CREATE TABLE IF NOT EXISTS canonical_institutional_amount_daily (
  date                   TEXT NOT NULL,
  market_segment         TEXT NOT NULL,
  investor               TEXT NOT NULL,
  category               TEXT,
  buy_amount             REAL,
  sell_amount            REAL,
  net_amount             REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(date, market_segment, investor, source)
);

CREATE INDEX IF NOT EXISTS idx_canonical_institutional_amount_daily_date
  ON canonical_institutional_amount_daily(date DESC, market_segment, investor);
