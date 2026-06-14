-- Migration: sector_flow turnover share delta
-- Adds XQ-style traded-value share and day-over-day share delta.

ALTER TABLE sector_flow ADD COLUMN turnover_value REAL;
ALTER TABLE sector_flow ADD COLUMN turnover_share REAL;
ALTER TABLE sector_flow ADD COLUMN turnover_share_delta REAL;
