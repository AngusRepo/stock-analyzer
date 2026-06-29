-- Extend existing production canonical_fundamental_features with FinLab P0 fields.
-- Fresh environments should use schema.sql; production already has this table.

ALTER TABLE canonical_fundamental_features ADD COLUMN roa REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN free_cash_flow REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN capital_amount REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN common_stock_capital REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN preferred_stock_capital REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN total_assets REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN total_liabilities REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN equity_parent REAL;

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_symbol_date
  ON canonical_fundamental_features(stock_id, available_date DESC, period DESC);
