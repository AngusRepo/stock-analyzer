-- FinLab regime/context canonical materialization.
-- Keeps TWSE/TPEX fallback paths separate; these tables are populated only by
-- explicit FinLab canonical materializer runs.

CREATE TABLE IF NOT EXISTS canonical_institutional_amount_daily (
  date                   TEXT NOT NULL,
  market_segment         TEXT NOT NULL,
  investor               TEXT NOT NULL,
  category               TEXT,
  buy_amount             REAL,
  sell_amount            REAL,
  net_amount             REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(date, market_segment, investor, source)
);
CREATE INDEX IF NOT EXISTS idx_canonical_institutional_amount_date
  ON canonical_institutional_amount_daily(date DESC, market_segment);

CREATE TABLE IF NOT EXISTS canonical_market_index_daily (
  symbol                 TEXT NOT NULL,
  date                   TEXT NOT NULL,
  name                   TEXT,
  market_segment         TEXT,
  open                   REAL,
  high                   REAL,
  low                    REAL,
  close                  REAL,
  change                 REAL,
  change_pct             REAL,
  volume                 REAL,
  value                  REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, date, source)
);
CREATE INDEX IF NOT EXISTS idx_canonical_market_index_symbol_date
  ON canonical_market_index_daily(symbol, date DESC);

CREATE TABLE IF NOT EXISTS canonical_futures_daily (
  symbol                 TEXT NOT NULL,
  date                   TEXT NOT NULL,
  contract_month         TEXT NOT NULL,
  session                TEXT NOT NULL DEFAULT 'day',
  open                   REAL,
  high                   REAL,
  low                    REAL,
  close                  REAL,
  change                 REAL,
  change_pct             REAL,
  volume                 REAL,
  open_interest          REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, date, contract_month, session, source)
);
CREATE INDEX IF NOT EXISTS idx_canonical_futures_symbol_date
  ON canonical_futures_daily(symbol, session, date DESC);

CREATE TABLE IF NOT EXISTS canonical_regime_context_daily (
  date                   TEXT NOT NULL,
  dataset                TEXT NOT NULL,
  field                  TEXT NOT NULL,
  category               TEXT NOT NULL DEFAULT 'market',
  value                  REAL,
  text_value             TEXT,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(date, dataset, field, category, source)
);
CREATE INDEX IF NOT EXISTS idx_canonical_regime_context_dataset_date
  ON canonical_regime_context_daily(dataset, date DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_regime_context_field_date
  ON canonical_regime_context_daily(field, category, date DESC);
