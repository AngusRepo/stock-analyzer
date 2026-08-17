-- Generated from schema.sql plus production snapshot fallback; do not edit by hand.
CREATE TABLE IF NOT EXISTS stock_prices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id   INTEGER NOT NULL,
  date       TEXT NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  adj_close  REAL,
  volume     INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE INDEX IF NOT EXISTS idx_prices_stock_date ON stock_prices(stock_id, date);

CREATE TABLE IF NOT EXISTS technical_indicators (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL,
  date         TEXT NOT NULL,
  ma5          REAL, ma10 REAL, ma20 REAL, ma60 REAL,
  rsi14        REAL,
  macd         REAL, macd_signal REAL, macd_hist REAL,
  atr14        REAL,
  plus_di14    REAL, minus_di14 REAL, adx14 REAL,
  parabolic_sar REAL,
  cci20        REAL,
  volume_weighted_rsi14 REAL,
  volume_momentum_divergence_13_27_10 REAL,
  squeeze_on REAL,
  squeeze_release REAL,
  squeeze_momentum REAL,
  obv_temperature_60 REAL,
  adaptive_rsi_midline_50 REAL,
  adaptive_rsi_upper_50 REAL,
  adaptive_rsi_lower_50 REAL,
  adaptive_rsi_overbought REAL,
  adaptive_rsi_oversold REAL,
  bb_upper     REAL, bb_mid REAL, bb_lower REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ti_stock_date ON technical_indicators(stock_id, date);

CREATE TABLE IF NOT EXISTS financials (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id           INTEGER NOT NULL,
  period             TEXT NOT NULL,
  period_type        TEXT NOT NULL CHECK(period_type IN ('monthly','quarterly','annual')),
  revenue            INTEGER,
  revenue_growth_yoy REAL,
  eps                REAL,
  roe                REAL,
  pe                 REAL,
  pb                 REAL,
  dividend_yield     REAL,
  dividend_per_share REAL,
  book_value_per_share REAL,
  price_at_record    REAL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, period)
);

CREATE INDEX IF NOT EXISTS idx_fin_stock_period ON financials(stock_id, period);

CREATE TABLE IF NOT EXISTS canonical_fundamental_features (
  stock_id                    TEXT NOT NULL,
  period                      TEXT NOT NULL,
  market_segment              TEXT,
  report_date                 TEXT,
  available_date              TEXT,
  revenue_growth_yoy          REAL,
  gross_margin                REAL,
  operating_margin            REAL,
  roe                         REAL,
  eps                         REAL,
  pe                          REAL,
  pb                          REAL,
  dividend_yield              REAL,
  revenue                     REAL,
  debt_ratio                  REAL,
  current_ratio               REAL,
  operating_cash_flow         REAL,
  industry_quality_percentile REAL,
  roa                         REAL,
  roa_comprehensive           REAL,
  roe_comprehensive           REAL,
  ebitda                      REAL,
  free_cash_flow              REAL,
  ebitda_margin               REAL,
  pretax_margin               REAL,
  net_margin                  REAL,
  non_operating_income_revenue_ratio REAL,
  berry_ratio                 REAL,
  operating_expense_ratio     REAL,
  sales_expense_ratio         REAL,
  admin_expense_ratio         REAL,
  rd_expense_ratio            REAL,
  cash_flow_ratio             REAL,
  tax_rate                    REAL,
  sales_per_share             REAL,
  operating_income_per_share  REAL,
  comprehensive_income_per_share REAL,
  liabilities_to_equity       REAL,
  equity_to_assets            REAL,
  gross_margin_growth         REAL,
  operating_income_growth     REAL,
  pretax_income_growth        REAL,
  net_income_growth           REAL,
  recurring_income_growth     REAL,
  total_assets_growth         REAL,
  equity_growth               REAL,
  quick_ratio                 REAL,
  interest_expense_ratio      REAL,
  total_asset_turnover        REAL,
  receivables_turnover        REAL,
  inventory_turnover          REAL,
  fixed_asset_turnover        REAL,
  equity_turnover             REAL,
  operating_income            REAL,
  net_income                  REAL,
  financial_cost              REAL,
  operating_expenses          REAL,
  cash_flow_per_share         REAL,
  pretax_income_per_share     REAL,
  property_plant_equipment    REAL,
  working_capital             REAL,
  current_liabilities         REAL,
  operating_cash_flow_statement REAL,
  non_current_assets          REAL,
  cash_and_cash_equivalents_increase_decrease REAL,
  other_payables              REAL,
  capital_amount              REAL,
  common_stock_capital        REAL,
  preferred_stock_capital     REAL,
  total_assets                REAL,
  total_liabilities           REAL,
  equity_parent               REAL,
  source                      TEXT NOT NULL,
  lineage_json                TEXT,
  as_of_date                  TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(stock_id, period, source)
);

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_symbol_date
  ON canonical_fundamental_features(stock_id, available_date DESC, period DESC);

CREATE TABLE IF NOT EXISTS chip_data (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT NOT NULL,
  date           TEXT NOT NULL,
  foreign_buy    INTEGER, foreign_sell INTEGER, foreign_net INTEGER,
  trust_buy      INTEGER, trust_sell   INTEGER, trust_net   INTEGER,
  dealer_buy     INTEGER, dealer_sell  INTEGER, dealer_net  INTEGER,
  margin_balance INTEGER,
  short_balance  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_chip_symbol_date ON chip_data(symbol, date);

CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  source       TEXT,
  sentiment    TEXT DEFAULT 'neutral' CHECK(sentiment IN ('positive','neutral','negative')),
  published_at TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, url)
);

CREATE INDEX IF NOT EXISTS idx_news_stock_date ON news(stock_id, published_at);

CREATE TABLE IF NOT EXISTS factor_scores (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id         INTEGER NOT NULL,
  date             TEXT NOT NULL,
  momentum1m       REAL, momentum3m REAL, momentum6m REAL,
  value_pe         REAL, value_pb REAL, value_dy REAL,
  quality_roe      REAL, quality_growth REAL,
  volatility       REAL, size REAL,
  z_momentum       REAL, z_value REAL, z_quality REAL,
  z_volatility     REAL, z_size REAL,
  composite_score  REAL,
  quantile         INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE TABLE IF NOT EXISTS sector_flow (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  sector          TEXT NOT NULL,
  foreign_net     REAL,
  trust_net       REAL,
  total_net       REAL,
  turnover_value  REAL,
  turnover_share  REAL,
  turnover_share_delta REAL,
  avg_rsi         REAL,
  avg_momentum_5d REAL,
  stock_count     INTEGER,
  up_count        INTEGER,
  llm_summary     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT,
  pit_lineage_version TEXT,
  classification TEXT DEFAULT 'industry',
  rs_ratio        REAL,
  rs_momentum     REAL,
  quadrant        TEXT,
  rotation_velocity REAL,
  rotation_acceleration REAL,
  quadrant_age    INTEGER,
  transition_path TEXT,
  rotation_score  REAL,
  rotation_regime TEXT,
  rotation_hysteresis TEXT,
  rotation_window INTEGER,
  taxonomy_snapshot_id TEXT,
  taxonomy_membership_checksum TEXT,
  knowledge_cutoff_date TEXT,
  reconstruction_mode TEXT,
  rrg_tail_json   TEXT,
  UNIQUE(date, sector, classification)
);

CREATE INDEX IF NOT EXISTS idx_sector_flow_date ON sector_flow(date DESC, total_net DESC);

CREATE INDEX IF NOT EXISTS idx_sector_flow_rotation_regime ON sector_flow(date, classification, rotation_regime);

CREATE INDEX IF NOT EXISTS idx_sector_flow_rotation_score ON sector_flow(date, classification, rotation_score DESC);

CREATE INDEX IF NOT EXISTS idx_sector_flow_pit_lineage ON sector_flow(pit_lineage_version, date DESC, updated_at);

CREATE TABLE IF NOT EXISTS sector_taxonomy_membership_snapshots_v1 (
  snapshot_date TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  tag_type TEXT NOT NULL,
  tag TEXT NOT NULL,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL,
  source_as_of_date TEXT NOT NULL,
  source_lineage_json TEXT,
  membership_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(snapshot_date, tag_type, tag, symbol)
);

CREATE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_v1_date_type
  ON sector_taxonomy_membership_snapshots_v1(snapshot_date, tag_type, tag);

CREATE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_v1_id
  ON sector_taxonomy_membership_snapshots_v1(snapshot_id, membership_checksum);

CREATE TABLE IF NOT EXISTS sector_taxonomy_snapshot_runs_v1 (
  snapshot_date TEXT NOT NULL,
  tag_type TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  membership_checksum TEXT NOT NULL,
  expected_row_count INTEGER NOT NULL,
  persisted_row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('writing', 'ready', 'failed')),
  error_code TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(snapshot_date, tag_type)
);

CREATE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_runs_v1_status
  ON sector_taxonomy_snapshot_runs_v1(status, snapshot_date, tag_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sector_taxonomy_snapshot_runs_v1_id
  ON sector_taxonomy_snapshot_runs_v1(snapshot_id);

CREATE INDEX IF NOT EXISTS idx_prices_date_stock ON stock_prices(date, stock_id);

CREATE TABLE IF NOT EXISTS market_breadth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  advance_count INTEGER,
  decline_count INTEGER,
  unchanged_count INTEGER,
  advance_ratio REAL,
  bull_alignment_pct REAL,
  new_high_count INTEGER,
  new_low_count INTEGER,
  margin_balance REAL,
  short_balance REAL,
  margin_maintenance REAL,
  sample_size INTEGER,
  limit_down_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS market_trading_sessions (
  session_date TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  materialized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(sample_size > 0)
);

CREATE TABLE IF NOT EXISTS intraday_minute_bars (
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  minute_start TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  session_epoch INTEGER,
  source_event_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trade_date, symbol, minute_start)
);

CREATE INDEX IF NOT EXISTS idx_ti_date_stock
  ON technical_indicators(date, stock_id);

CREATE INDEX IF NOT EXISTS idx_chip_date_symbol
  ON chip_data(date, symbol);

CREATE INDEX IF NOT EXISTS idx_sector_flow_date_class_total
  ON sector_flow(date, classification, total_net DESC);

CREATE INDEX IF NOT EXISTS idx_news_published_id
  ON news(published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_news_created_id
  ON news(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_features_available
  ON canonical_fundamental_features(available_date DESC, stock_id);

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_features_symbol_period
  ON canonical_fundamental_features(stock_id, period DESC);

CREATE INDEX IF NOT EXISTS idx_intraday_minute_bars_symbol_date
  ON intraday_minute_bars(symbol, trade_date, minute_start);

CREATE TABLE IF NOT EXISTS canonical_revenue_observations_v2 (
  stock_id TEXT NOT NULL,
  revenue_month TEXT NOT NULL,
  market_segment TEXT,
  revenue REAL,
  previous_month_revenue REAL,
  last_year_month_revenue REAL,
  mom REAL,
  yoy REAL,
  cumulative_revenue REAL,
  last_year_cumulative_revenue REAL,
  previous_comparison_pct REAL,
  source TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  source_as_of_date TEXT NOT NULL,
  knowledge_time TEXT NOT NULL,
  observation_run_id TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, revenue_month, source, payload_checksum),
  CHECK(length(payload_checksum) = 71)
);

CREATE INDEX IF NOT EXISTS idx_revenue_observations_v2_stock_knowledge
  ON canonical_revenue_observations_v2(stock_id, knowledge_time, revenue_month);
