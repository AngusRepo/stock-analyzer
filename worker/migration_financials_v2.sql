-- Migration: Add complete financial statement fields to financials table
-- Safe: All columns are nullable, won't break existing data

ALTER TABLE financials ADD COLUMN operating_income REAL;
ALTER TABLE financials ADD COLUMN net_income REAL;
ALTER TABLE financials ADD COLUMN total_assets REAL;
ALTER TABLE financials ADD COLUMN total_liabilities REAL;
