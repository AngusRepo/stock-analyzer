CREATE TABLE IF NOT EXISTS canonical_market_summary_daily (
  date                       TEXT NOT NULL,
  market_segment             TEXT NOT NULL,
  advance_count              REAL,
  unchanged_count            REAL,
  decline_count              REAL,
  total_volume               REAL,
  total_value                REAL,
  margin_buy_units           REAL,
  margin_sell_units          REAL,
  margin_return_units        REAL,
  margin_balance_units       REAL,
  margin_buy_value           REAL,
  margin_sell_value          REAL,
  margin_return_value        REAL,
  margin_balance_value       REAL,
  margin_balance_change_pct  REAL,
  short_buy_units            REAL,
  short_sell_units           REAL,
  short_return_units         REAL,
  short_balance_units        REAL,
  short_balance_change_pct   REAL,
  source                     TEXT NOT NULL,
  lineage_json               TEXT NOT NULL,
  as_of_date                 TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(date, market_segment)
);

CREATE INDEX IF NOT EXISTS idx_canonical_market_summary_daily_date
  ON canonical_market_summary_daily(date DESC);

