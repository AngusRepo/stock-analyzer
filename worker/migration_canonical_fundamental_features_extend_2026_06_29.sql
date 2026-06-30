-- Extend existing production canonical_fundamental_features with FinLab P0 fields.
-- Fresh environments should use schema.sql; production already has this table.

ALTER TABLE canonical_fundamental_features ADD COLUMN roa REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN ebitda REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN free_cash_flow REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN financial_cost REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN operating_expenses REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN cash_flow_per_share REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN pretax_income_per_share REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN property_plant_equipment REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN working_capital REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN current_liabilities REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN operating_cash_flow_statement REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN non_current_assets REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN cash_and_cash_equivalents_increase_decrease REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN other_payables REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN capital_amount REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN common_stock_capital REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN preferred_stock_capital REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN total_assets REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN total_liabilities REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN equity_parent REAL;

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_symbol_date
  ON canonical_fundamental_features(stock_id, available_date DESC, period DESC);
