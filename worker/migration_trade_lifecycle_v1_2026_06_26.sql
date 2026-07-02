-- Canonical trade lifecycle contract for paper positions.
-- Apply before deploying code that writes paper_positions.trade_lifecycle_json.
ALTER TABLE paper_positions ADD COLUMN trade_lifecycle_json TEXT;
