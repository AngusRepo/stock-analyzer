-- Score V2 Phase 5: canonical FinLab fundamental-quality features.
-- FinLab structured data is the primary daily path; legacy financials remains fallback/audit only.

CREATE TABLE IF NOT EXISTS canonical_fundamental_features (
  stock_id                    TEXT NOT NULL,
  period                      TEXT NOT NULL,
  market_segment              TEXT,
  report_date                 TEXT,
  available_date              TEXT NOT NULL,
  revenue_growth_yoy          REAL,
  gross_margin                REAL,
  operating_margin            REAL,
  roe                         REAL,
  eps                         REAL,
  pe                          REAL,
  pb                          REAL,
  dividend_yield              REAL,
  debt_ratio                  REAL,
  current_ratio               REAL,
  operating_cash_flow         REAL,
  industry_quality_percentile REAL,
  source                      TEXT NOT NULL,
  lineage_json                TEXT NOT NULL,
  as_of_date                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, period, source)
);

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_features_available
  ON canonical_fundamental_features(available_date DESC, stock_id);

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_features_symbol_period
  ON canonical_fundamental_features(stock_id, period DESC);
