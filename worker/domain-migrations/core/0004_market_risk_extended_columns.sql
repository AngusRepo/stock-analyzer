-- Keep the split Core D1 schema aligned with the production market_risk v2 contract.
ALTER TABLE market_risk ADD COLUMN adl_value REAL;
ALTER TABLE market_risk ADD COLUMN adl_trend TEXT;
ALTER TABLE market_risk ADD COLUMN margin_maintenance_rate REAL;
ALTER TABLE market_risk ADD COLUMN bull_alignment_count INTEGER;
ALTER TABLE market_risk ADD COLUMN bull_alignment_pct REAL;
