-- Migration: adaptive RSI dynamic bands
-- Adds instrument-specific RSI band fields from RSI14 over a 50-bar band window.

ALTER TABLE technical_indicators ADD COLUMN adaptive_rsi_midline_50 REAL;
ALTER TABLE technical_indicators ADD COLUMN adaptive_rsi_upper_50 REAL;
ALTER TABLE technical_indicators ADD COLUMN adaptive_rsi_lower_50 REAL;
ALTER TABLE technical_indicators ADD COLUMN adaptive_rsi_overbought REAL;
ALTER TABLE technical_indicators ADD COLUMN adaptive_rsi_oversold REAL;
