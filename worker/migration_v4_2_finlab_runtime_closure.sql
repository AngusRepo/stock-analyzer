-- V4.2 FinLab runtime closure.
-- FinLab is the primary structured source; official TWSE/TPEX remains audit/fallback.

CREATE TABLE IF NOT EXISTS canonical_trading_restrictions (
  symbol                 TEXT NOT NULL,
  restriction_type       TEXT NOT NULL,
  market_segment         TEXT,
  start_date             TEXT,
  end_date               TEXT,
  source                 TEXT NOT NULL,
  source_date            TEXT NOT NULL,
  title                  TEXT,
  source_url             TEXT,
  lineage_json           TEXT NOT NULL,
  active                 INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, restriction_type, source, source_date)
);
CREATE INDEX IF NOT EXISTS idx_canonical_trading_restrictions_active
  ON canonical_trading_restrictions(active, source_date DESC, restriction_type);
CREATE INDEX IF NOT EXISTS idx_canonical_trading_restrictions_symbol
  ON canonical_trading_restrictions(symbol, source_date DESC);

CREATE TABLE IF NOT EXISTS market_regime_factor_packets (
  date                   TEXT PRIMARY KEY,
  schema_version         TEXT NOT NULL,
  score                  INTEGER NOT NULL,
  level                  TEXT NOT NULL,
  factor_json            TEXT NOT NULL,
  contribution_json      TEXT NOT NULL,
  source_json            TEXT NOT NULL,
  freshness_json         TEXT NOT NULL,
  missing_reason_json    TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  generated_at           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_market_regime_factor_packets_generated
  ON market_regime_factor_packets(generated_at DESC);
