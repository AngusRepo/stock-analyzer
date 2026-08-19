-- Align the inactive Market target with the current legacy source schema.
-- The canonical fundamental rebuild is atomic: any incompatible existing row
-- aborts the migration before the old table is dropped.

ALTER TABLE financials ADD COLUMN operating_income REAL;
ALTER TABLE financials ADD COLUMN net_income REAL;
ALTER TABLE financials ADD COLUMN total_assets REAL;
ALTER TABLE financials ADD COLUMN total_liabilities REAL;
ALTER TABLE stock_prices ADD COLUMN avg_price REAL;
ALTER TABLE sector_flow ADD COLUMN taxonomy_snapshot_id TEXT;
ALTER TABLE sector_flow ADD COLUMN taxonomy_membership_checksum TEXT;
ALTER TABLE sector_flow ADD COLUMN knowledge_cutoff_date TEXT;
ALTER TABLE sector_flow ADD COLUMN reconstruction_mode TEXT;

ALTER TABLE canonical_fundamental_features
  RENAME TO canonical_fundamental_features_pre_alignment;

CREATE TABLE canonical_fundamental_features (
  stock_id TEXT NOT NULL,
  period TEXT NOT NULL,
  market_segment TEXT,
  report_date TEXT,
  available_date TEXT NOT NULL,
  revenue_growth_yoy REAL,
  gross_margin REAL,
  operating_margin REAL,
  roe REAL,
  eps REAL,
  pe REAL,
  pb REAL,
  dividend_yield REAL,
  debt_ratio REAL,
  current_ratio REAL,
  operating_cash_flow REAL,
  industry_quality_percentile REAL,
  source TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  roa REAL,
  free_cash_flow REAL,
  capital_amount REAL,
  common_stock_capital REAL,
  preferred_stock_capital REAL,
  total_assets REAL,
  total_liabilities REAL,
  equity_parent REAL,
  ebitda REAL,
  financial_cost REAL,
  operating_expenses REAL,
  cash_flow_per_share REAL,
  pretax_income_per_share REAL,
  property_plant_equipment REAL,
  working_capital REAL,
  current_liabilities REAL,
  operating_cash_flow_statement REAL,
  non_current_assets REAL,
  cash_and_cash_equivalents_increase_decrease REAL,
  other_payables REAL,
  roa_comprehensive REAL,
  roe_comprehensive REAL,
  ebitda_margin REAL,
  pretax_margin REAL,
  net_margin REAL,
  non_operating_income_revenue_ratio REAL,
  berry_ratio REAL,
  operating_expense_ratio REAL,
  sales_expense_ratio REAL,
  admin_expense_ratio REAL,
  rd_expense_ratio REAL,
  cash_flow_ratio REAL,
  tax_rate REAL,
  sales_per_share REAL,
  operating_income_per_share REAL,
  comprehensive_income_per_share REAL,
  liabilities_to_equity REAL,
  equity_to_assets REAL,
  gross_margin_growth REAL,
  operating_income_growth REAL,
  pretax_income_growth REAL,
  net_income_growth REAL,
  recurring_income_growth REAL,
  total_assets_growth REAL,
  equity_growth REAL,
  quick_ratio REAL,
  interest_expense_ratio REAL,
  total_asset_turnover REAL,
  receivables_turnover REAL,
  inventory_turnover REAL,
  fixed_asset_turnover REAL,
  equity_turnover REAL,
  revenue REAL,
  operating_income REAL,
  net_income REAL,
  PRIMARY KEY(stock_id, period, source)
);

INSERT INTO canonical_fundamental_features (
  stock_id, period, market_segment, report_date, available_date,
  revenue_growth_yoy, gross_margin, operating_margin, roe, eps, pe, pb,
  dividend_yield, debt_ratio, current_ratio, operating_cash_flow,
  industry_quality_percentile, source, lineage_json, as_of_date, created_at,
  roa, free_cash_flow, capital_amount, common_stock_capital,
  preferred_stock_capital, total_assets, total_liabilities, equity_parent,
  ebitda, financial_cost, operating_expenses, cash_flow_per_share,
  pretax_income_per_share, property_plant_equipment, working_capital,
  current_liabilities, operating_cash_flow_statement, non_current_assets,
  cash_and_cash_equivalents_increase_decrease, other_payables,
  roa_comprehensive, roe_comprehensive, ebitda_margin, pretax_margin,
  net_margin, non_operating_income_revenue_ratio, berry_ratio,
  operating_expense_ratio, sales_expense_ratio, admin_expense_ratio,
  rd_expense_ratio, cash_flow_ratio, tax_rate, sales_per_share,
  operating_income_per_share, comprehensive_income_per_share,
  liabilities_to_equity, equity_to_assets, gross_margin_growth,
  operating_income_growth, pretax_income_growth, net_income_growth,
  recurring_income_growth, total_assets_growth, equity_growth, quick_ratio,
  interest_expense_ratio, total_asset_turnover, receivables_turnover,
  inventory_turnover, fixed_asset_turnover, equity_turnover, revenue,
  operating_income, net_income
)
SELECT
  stock_id, period, market_segment, report_date, available_date,
  revenue_growth_yoy, gross_margin, operating_margin, roe, eps, pe, pb,
  dividend_yield, debt_ratio, current_ratio, operating_cash_flow,
  industry_quality_percentile, source, lineage_json, as_of_date, created_at,
  roa, free_cash_flow, capital_amount, common_stock_capital,
  preferred_stock_capital, total_assets, total_liabilities, equity_parent,
  ebitda, financial_cost, operating_expenses, cash_flow_per_share,
  pretax_income_per_share, property_plant_equipment, working_capital,
  current_liabilities, operating_cash_flow_statement, non_current_assets,
  cash_and_cash_equivalents_increase_decrease, other_payables,
  roa_comprehensive, roe_comprehensive, ebitda_margin, pretax_margin,
  net_margin, non_operating_income_revenue_ratio, berry_ratio,
  operating_expense_ratio, sales_expense_ratio, admin_expense_ratio,
  rd_expense_ratio, cash_flow_ratio, tax_rate, sales_per_share,
  operating_income_per_share, comprehensive_income_per_share,
  liabilities_to_equity, equity_to_assets, gross_margin_growth,
  operating_income_growth, pretax_income_growth, net_income_growth,
  recurring_income_growth, total_assets_growth, equity_growth, quick_ratio,
  interest_expense_ratio, total_asset_turnover, receivables_turnover,
  inventory_turnover, fixed_asset_turnover, equity_turnover, revenue,
  operating_income, net_income
FROM canonical_fundamental_features_pre_alignment;

DROP TABLE canonical_fundamental_features_pre_alignment;
CREATE INDEX idx_canonical_fundamental_features_available
  ON canonical_fundamental_features(available_date DESC, stock_id);
CREATE INDEX idx_canonical_fundamental_features_symbol_period
  ON canonical_fundamental_features(stock_id, period DESC);
CREATE INDEX idx_canonical_fundamental_symbol_date
  ON canonical_fundamental_features(stock_id, available_date DESC, period DESC);