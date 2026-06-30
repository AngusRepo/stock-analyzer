-- Add FinLab adjusted OHLC fields for split/dividend-adjusted price series.

ALTER TABLE canonical_market_daily ADD COLUMN adj_open REAL;
ALTER TABLE canonical_market_daily ADD COLUMN adj_high REAL;
ALTER TABLE canonical_market_daily ADD COLUMN adj_low REAL;
ALTER TABLE canonical_market_daily ADD COLUMN adj_close REAL;
