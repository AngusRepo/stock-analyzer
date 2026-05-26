-- XQ-derived Score V2 technical factors:
-- - TTM Squeeze state/release/momentum
-- - OBV 60-bar temperature normalized to 0..100

ALTER TABLE technical_indicators ADD COLUMN squeeze_on REAL;
ALTER TABLE technical_indicators ADD COLUMN squeeze_release REAL;
ALTER TABLE technical_indicators ADD COLUMN squeeze_momentum REAL;
ALTER TABLE technical_indicators ADD COLUMN obv_temperature_60 REAL;
