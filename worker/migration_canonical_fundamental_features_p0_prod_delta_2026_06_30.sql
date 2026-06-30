-- Production delta for canonical_fundamental_features P0 FinLab fields.
-- 2026-06-29 production already has roa/free_cash_flow/capital/asset columns;
-- apply only the columns still missing in remote D1.

ALTER TABLE canonical_fundamental_features ADD COLUMN ebitda REAL;
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
