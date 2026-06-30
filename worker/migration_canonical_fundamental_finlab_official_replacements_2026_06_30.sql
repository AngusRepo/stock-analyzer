-- Add FinLab fields needed to replace Wave2 official financial statement rows.
-- Values are populated from FinLab canonical_fundamental_features.

ALTER TABLE canonical_fundamental_features ADD COLUMN revenue REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN operating_income REAL;
ALTER TABLE canonical_fundamental_features ADD COLUMN net_income REAL;
