-- V4.1 local runtime closure: FinLab backfill/diff and external evidence signals.

CREATE TABLE IF NOT EXISTS finlab_backfill_runs (
  run_id          TEXT PRIMARY KEY,
  generated_at    TEXT NOT NULL,
  lookback_years  INTEGER NOT NULL DEFAULT 5,
  dataset_count   INTEGER NOT NULL DEFAULT 0,
  finlab_rows     INTEGER NOT NULL DEFAULT 0,
  gap_fill_rows   INTEGER NOT NULL DEFAULT 0,
  value_conflicts INTEGER NOT NULL DEFAULT 0,
  checksum        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready',
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_diff_report (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  dataset_lane           TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'finlab',
  generated_at           TEXT NOT NULL,
  finlab_rows            INTEGER NOT NULL DEFAULT 0,
  stockvision_rows       INTEGER NOT NULL DEFAULT 0,
  matched_rows           INTEGER NOT NULL DEFAULT 0,
  missing_in_stockvision INTEGER NOT NULL DEFAULT 0,
  missing_in_finlab      INTEGER NOT NULL DEFAULT 0,
  value_conflicts        INTEGER NOT NULL DEFAULT 0,
  schema_extra_fields    TEXT,
  report_json            TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_source_diff_report_run ON source_diff_report(run_id, dataset_lane);
CREATE INDEX IF NOT EXISTS idx_source_diff_report_lane ON source_diff_report(dataset_lane, generated_at DESC);

CREATE TABLE IF NOT EXISTS gap_fill_candidates (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT NOT NULL,
  dataset_lane           TEXT NOT NULL,
  canonical_table        TEXT NOT NULL,
  stock_id               TEXT,
  symbol                 TEXT,
  date                   TEXT,
  market_segment         TEXT,
  field                  TEXT,
  finlab_value           TEXT,
  stockvision_value      TEXT,
  source                 TEXT NOT NULL DEFAULT 'finlab',
  lineage_json           TEXT NOT NULL,
  decision               TEXT NOT NULL DEFAULT 'candidate',
  generated_at           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gap_fill_candidates_run ON gap_fill_candidates(run_id, dataset_lane);
CREATE INDEX IF NOT EXISTS idx_gap_fill_candidates_key ON gap_fill_candidates(stock_id, date, field);

CREATE TABLE IF NOT EXISTS data_source_inventory (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  source                 TEXT NOT NULL,
  dataset                TEXT NOT NULL,
  field                  TEXT NOT NULL,
  stock_id               TEXT,
  market_segment         TEXT,
  date                   TEXT,
  as_of_date             TEXT NOT NULL,
  coverage_status        TEXT NOT NULL,
  freshness_status       TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, dataset, field, stock_id, market_segment, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_data_source_inventory_dataset ON data_source_inventory(dataset, as_of_date DESC);

CREATE TABLE IF NOT EXISTS canonical_market_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT,
  open                   REAL,
  high                   REAL,
  low                    REAL,
  close                  REAL,
  adj_open               REAL,
  adj_high               REAL,
  adj_low                REAL,
  adj_close              REAL,
  volume                 REAL,
  trade_count            REAL,
  value                  REAL,
  avg_price              REAL,
  last_bid_price         REAL,
  last_ask_price         REAL,
  last_bid_volume        REAL,
  last_ask_volume        REAL,
  market_value           REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source)
);

CREATE TABLE IF NOT EXISTS canonical_chip_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT,
  foreign_buy            REAL,
  foreign_sell           REAL,
  foreign_net            REAL,
  foreign_dealer_buy     REAL,
  foreign_dealer_sell    REAL,
  foreign_dealer_net     REAL,
  trust_buy              REAL,
  trust_sell             REAL,
  trust_net              REAL,
  dealer_buy             REAL,
  dealer_sell            REAL,
  dealer_net             REAL,
  dealer_self_buy        REAL,
  dealer_self_sell       REAL,
  dealer_hedge_buy       REAL,
  dealer_hedge_sell      REAL,
  margin_buy             REAL,
  margin_sell            REAL,
  margin_cash_repayment  REAL,
  margin_prev_balance    REAL,
  margin_balance         REAL,
  margin_limit           REAL,
  short_buy              REAL,
  short_sell             REAL,
  short_stock_repayment  REAL,
  short_prev_balance     REAL,
  short_balance          REAL,
  short_limit            REAL,
  margin_short_offset    REAL,
  margin_usage_ratio     REAL,
  short_usage_ratio      REAL,
  margin_balance_total_buy REAL,
  margin_balance_total_sell REAL,
  margin_balance_total_repayment REAL,
  margin_balance_total_balance REAL,
  security_lending_prev_balance REAL,
  security_lending_borrow REAL,
  security_lending_return REAL,
  security_lending_delta REAL,
  security_lending_balance REAL,
  security_lending_sell REAL,
  security_lending_sell_return REAL,
  security_lending_sell_balance REAL,
  security_lending_sell_limit REAL,
  broker_top15_buy       REAL,
  broker_top15_sell      REAL,
  broker_buy_sell_ratio  REAL,
  broker_balance_index   REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source)
);

CREATE TABLE IF NOT EXISTS canonical_revenue_monthly (
  stock_id               TEXT NOT NULL,
  revenue_month          TEXT NOT NULL,
  market_segment         TEXT,
  revenue                REAL,
  previous_month_revenue REAL,
  last_year_month_revenue REAL,
  mom                    REAL,
  yoy                    REAL,
  cumulative_revenue     REAL,
  last_year_cumulative_revenue REAL,
  previous_comparison_pct REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, revenue_month, source)
);

CREATE TABLE IF NOT EXISTS source_quality_metrics (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  source                 TEXT NOT NULL,
  dataset                TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  freshness_status       TEXT NOT NULL,
  missing_rate           REAL NOT NULL DEFAULT 0,
  duplicate_rate         REAL NOT NULL DEFAULT 0,
  schema_drift_status    TEXT NOT NULL DEFAULT 'ok',
  entity_link_confidence REAL,
  latest_materialization TEXT,
  metrics_json           TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, dataset, as_of_date)
);
CREATE INDEX IF NOT EXISTS idx_source_quality_metrics_source ON source_quality_metrics(source, dataset, as_of_date DESC);

CREATE TABLE IF NOT EXISTS external_evidence_items (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id                  TEXT NOT NULL,
  source_kind                TEXT NOT NULL,
  title                      TEXT NOT NULL,
  published_at               TEXT NOT NULL,
  source_url                 TEXT NOT NULL,
  symbols_json               TEXT,
  themes_json                TEXT,
  allowed_use                TEXT NOT NULL,
  decision_effect            TEXT NOT NULL,
  source_quality_score       REAL NOT NULL,
  entity_linking_confidence  REAL NOT NULL,
  spam_filter_status         TEXT NOT NULL DEFAULT 'clean',
  accepted                   INTEGER NOT NULL DEFAULT 1,
  packet_checksum            TEXT,
  raw_json                   TEXT,
  created_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_external_evidence_source_date ON external_evidence_items(source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_evidence_accepted ON external_evidence_items(accepted, published_at DESC);

CREATE TABLE IF NOT EXISTS theme_signals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT NOT NULL,
  concept          TEXT NOT NULL,
  source           TEXT NOT NULL,
  score            REAL NOT NULL,
  sentiment_avg    REAL NOT NULL DEFAULT 0,
  evidence_count   INTEGER NOT NULL DEFAULT 1,
  symbols_json     TEXT,
  top_titles       TEXT,
  allowed_use      TEXT,
  decision_effect  TEXT,
  generated_at     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, concept, source)
);
CREATE INDEX IF NOT EXISTS idx_theme_signals_date_score ON theme_signals(date DESC, score DESC);
CREATE INDEX IF NOT EXISTS idx_theme_signals_concept ON theme_signals(concept, date DESC);

CREATE TABLE IF NOT EXISTS stock_theme_features (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  concept               TEXT NOT NULL,
  score                 REAL NOT NULL,
  evidence_count        INTEGER NOT NULL DEFAULT 1,
  source_breakdown_json TEXT,
  top_titles            TEXT,
  generated_at          TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, concept)
);
CREATE INDEX IF NOT EXISTS idx_stock_theme_features_date_score ON stock_theme_features(date DESC, score DESC);
CREATE INDEX IF NOT EXISTS idx_stock_theme_features_symbol ON stock_theme_features(symbol, date DESC);
