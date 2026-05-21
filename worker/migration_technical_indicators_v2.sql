-- migration_technical_indicators_v2.sql — Score V2 technical factor columns
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_technical_indicators_v2.sql

ALTER TABLE technical_indicators ADD COLUMN plus_di14 REAL;
ALTER TABLE technical_indicators ADD COLUMN minus_di14 REAL;
ALTER TABLE technical_indicators ADD COLUMN adx14 REAL;
ALTER TABLE technical_indicators ADD COLUMN parabolic_sar REAL;
ALTER TABLE technical_indicators ADD COLUMN cci20 REAL;
ALTER TABLE technical_indicators ADD COLUMN volume_weighted_rsi14 REAL;
ALTER TABLE technical_indicators ADD COLUMN volume_momentum_divergence_13_27_10 REAL;
