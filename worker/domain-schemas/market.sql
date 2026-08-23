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

CREATE TABLE IF NOT EXISTS market_regime_state_history_v1 (
  run_date TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK(schema_version='market-regime-state-v1'),
  effective_label TEXT NOT NULL CHECK(effective_label IN ('bull_market','bear_market','volatile','sideways')),
  raw_label TEXT NOT NULL CHECK(raw_label IN ('bull_market','bear_market','volatile','sideways')),
  family TEXT NOT NULL CHECK(family IN ('bull','bear','volatile','sideways')),
  source TEXT NOT NULL,
  hmm_state INTEGER NOT NULL,
  regime_index INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  state_checksum TEXT NOT NULL CHECK(length(state_checksum)=64),
  computed_at TEXT NOT NULL,
  persisted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_market_regime_state_history_v1_computed
  ON market_regime_state_history_v1(computed_at DESC, run_date DESC);

CREATE TABLE IF NOT EXISTS sector_heat (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL,
  sector            TEXT NOT NULL,
  score             REAL NOT NULL,
  chip_flow         REAL,
  relative_strength REAL,
  volume_expansion  REAL,
  momentum          REAL,
  top_stocks        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, sector)
);

CREATE TABLE IF NOT EXISTS stock_tags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol    TEXT NOT NULL,
  tag       TEXT NOT NULL,
  source    TEXT DEFAULT 'goodinfo',
  weight    REAL DEFAULT 1.0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), tag_type TEXT DEFAULT 'concept',
  UNIQUE(symbol, tag)
);

CREATE TABLE IF NOT EXISTS concept_buzz (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  concept    TEXT NOT NULL,
  mention_count INTEGER DEFAULT 0,
  sentiment_avg REAL DEFAULT 0,
  top_posts  TEXT,
  source     TEXT DEFAULT 'ptt',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, concept, source)
);

CREATE TABLE IF NOT EXISTS monthly_revenue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id    INTEGER NOT NULL,
  date        TEXT NOT NULL,
  revenue     REAL NOT NULL,
  revenue_yoy REAL,
  revenue_mom REAL,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE TABLE IF NOT EXISTS us_market_signals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT NOT NULL UNIQUE,
  sox_close         REAL,
  sox_return        REAL,
  sox_ma5           REAL,
  tsm_close         REAL,
  tsm_return        REAL,
  tsm_premium       REAL,
  gspc_close        REAL,
  gspc_return       REAL,
  dxy_close         REAL,
  dxy_return        REAL,
  hy_spread         REAL,
  hy_spread_chg     REAL,
  vix_close         REAL,
  sentiment         TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS margin_data (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id              INTEGER NOT NULL,
  date                  TEXT NOT NULL,
  margin_buy            INTEGER,
  margin_sell           INTEGER,
  margin_balance        INTEGER,
  short_buy             INTEGER,
  short_sell            INTEGER,
  short_balance         INTEGER,
  margin_usage_pct      REAL,
  short_ratio           REAL,
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE TABLE IF NOT EXISTS shareholding (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id              INTEGER NOT NULL,
  date                  TEXT NOT NULL,
  total_shares          INTEGER,
  holder_count          INTEGER,
  retail_shares         INTEGER,
  retail_pct            REAL,
  large_holder_shares   INTEGER,
  large_holder_pct      REAL,
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(stock_id, date)
);

CREATE TABLE IF NOT EXISTS stock_profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL UNIQUE,
  name              TEXT,
  sector            TEXT,
  business_desc     TEXT,
  supply_chain      TEXT,
  key_customers     TEXT,
  key_suppliers     TEXT,
  financials_summary TEXT,
  wikilinks         TEXT,
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sector_flow_stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  theme TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  net_amount REAL NOT NULL,
  foreign_net REAL DEFAULT 0,
  trust_net REAL DEFAULT 0,
  volume_ratio REAL,
  classification TEXT NOT NULL DEFAULT 'top',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS screener_momentum_snapshots (
  date                  TEXT PRIMARY KEY,
  candidate_count       INTEGER NOT NULL,
  avg_5d_return         REAL,
  pct_oversold          REAL,
  pct_overbought        REAL,
  avg_dist_from_high    REAL,
  breadth_score         REAL,

  percentile_rank       REAL,
  zone                  TEXT NOT NULL DEFAULT 'GREEN',
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS screener_selection_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  stock_id   INTEGER,
  symbol     TEXT NOT NULL,
  score      REAL,
  industry   TEXT,
  UNIQUE(date, symbol)
);

CREATE TABLE IF NOT EXISTS sector_leaders (
  sector            TEXT NOT NULL,
  rank              INTEGER NOT NULL,
  stock_id          INTEGER,
  symbol            TEXT NOT NULL,
  avg_turnover_60d  REAL,
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (sector, rank)
);

CREATE TABLE IF NOT EXISTS stock_trading_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  restriction_type TEXT NOT NULL DEFAULT 'punished',
  source TEXT NOT NULL DEFAULT 'twse',
  reason TEXT,
  start_date TEXT,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS canonical_market_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT,
  open                   REAL,
  high                   REAL,
  low                    REAL,
  close                  REAL,
  volume                 REAL,
  value                  REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, adj_open REAL, adj_high REAL, adj_low REAL, adj_close REAL, market_value REAL, trade_count REAL, avg_price REAL, last_bid_price REAL, last_ask_price REAL, last_bid_volume REAL, last_ask_volume REAL,
  PRIMARY KEY(stock_id, date, source)
);

CREATE TABLE IF NOT EXISTS canonical_chip_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT,
  foreign_net            REAL,
  trust_net              REAL,
  dealer_net             REAL,
  margin_balance         REAL,
  short_balance          REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, broker_top15_buy REAL, broker_top15_sell REAL, broker_buy_sell_ratio REAL, broker_balance_index REAL, margin_buy REAL, margin_sell REAL, margin_cash_repayment REAL, margin_prev_balance REAL, margin_limit REAL, short_buy REAL, short_sell REAL, short_stock_repayment REAL, short_prev_balance REAL, short_limit REAL, margin_short_offset REAL, margin_usage_ratio REAL, short_usage_ratio REAL, foreign_buy REAL, foreign_sell REAL, foreign_dealer_buy REAL, foreign_dealer_sell REAL, foreign_dealer_net REAL, trust_buy REAL, trust_sell REAL, dealer_buy REAL, dealer_sell REAL, dealer_self_buy REAL, dealer_self_sell REAL, dealer_hedge_buy REAL, dealer_hedge_sell REAL, margin_balance_total_buy REAL, margin_balance_total_sell REAL, margin_balance_total_repayment REAL, margin_balance_total_balance REAL, security_lending_prev_balance REAL, security_lending_borrow REAL, security_lending_return REAL, security_lending_delta REAL, security_lending_balance REAL, security_lending_sell REAL, security_lending_sell_return REAL, security_lending_sell_balance REAL, security_lending_sell_limit REAL,
  PRIMARY KEY(stock_id, date, source)
);

CREATE TABLE IF NOT EXISTS canonical_revenue_monthly (
  stock_id               TEXT NOT NULL,
  revenue_month          TEXT NOT NULL,
  market_segment         TEXT,
  revenue                REAL,
  mom                    REAL,
  yoy                    REAL,
  source                 TEXT NOT NULL,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, previous_month_revenue REAL, last_year_month_revenue REAL, cumulative_revenue REAL, last_year_cumulative_revenue REAL, previous_comparison_pct REAL,
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

CREATE TABLE IF NOT EXISTS canonical_broker_flow_daily (
  stock_id               TEXT NOT NULL,
  date                   TEXT NOT NULL,
  market_segment         TEXT NOT NULL DEFAULT 'EMERGING',
  buy_shares             REAL,
  sell_shares            REAL,
  net_shares             REAL,
  dominant_net_shares    REAL,
  gross_imbalance_shares REAL,
  estimated_amount       REAL,
  broker_count           INTEGER,
  concentration          REAL,
  source                 TEXT NOT NULL DEFAULT 'finlab.rotc_broker_transactions',
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source)
);

CREATE TABLE IF NOT EXISTS finlab_taxonomy_tags (
  symbol                 TEXT NOT NULL,
  tag                    TEXT NOT NULL,
  tag_type               TEXT NOT NULL,
  source                 TEXT NOT NULL,
  weight                 REAL NOT NULL DEFAULT 1,
  lineage_json           TEXT NOT NULL,
  as_of_date             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(symbol, tag, tag_type, source)
);

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

CREATE TABLE IF NOT EXISTS canonical_broker_rank_daily (
  stock_id       TEXT NOT NULL,
  date           TEXT NOT NULL,
  market_segment TEXT NOT NULL DEFAULT 'LISTED_OTC',
  rank_side      TEXT NOT NULL CHECK(rank_side IN ('buy', 'sell')),
  rank_no        INTEGER NOT NULL CHECK(rank_no BETWEEN 1 AND 3),
  broker_code    TEXT,
  broker_name    TEXT,
  buy_lots       REAL,
  sell_lots      REAL,
  net_lots       REAL,
  source         TEXT NOT NULL DEFAULT 'finlab.broker_transactions',
  lineage_json   TEXT NOT NULL,
  as_of_date     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, date, source, rank_side, rank_no)
);

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

CREATE TABLE IF NOT EXISTS canonical_market_summary_daily (
  date                       TEXT NOT NULL,
  market_segment             TEXT NOT NULL,
  advance_count              REAL,
  unchanged_count            REAL,
  decline_count              REAL,
  total_volume               REAL,
  total_value                REAL,
  margin_buy_units           REAL,
  margin_sell_units          REAL,
  margin_return_units        REAL,
  margin_balance_units       REAL,
  margin_buy_value           REAL,
  margin_sell_value          REAL,
  margin_return_value        REAL,
  margin_balance_value       REAL,
  margin_balance_change_pct  REAL,
  short_buy_units            REAL,
  short_sell_units           REAL,
  short_return_units         REAL,
  short_balance_units        REAL,
  short_balance_change_pct   REAL,
  source                     TEXT NOT NULL,
  lineage_json               TEXT NOT NULL,
  as_of_date                 TEXT NOT NULL,
  created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(date, market_segment)
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

CREATE INDEX IF NOT EXISTS idx_sector_heat_date ON sector_heat(date DESC, score DESC);

CREATE INDEX IF NOT EXISTS idx_stock_tags_symbol ON stock_tags(symbol);

CREATE INDEX IF NOT EXISTS idx_stock_tags_tag ON stock_tags(tag);

CREATE INDEX IF NOT EXISTS idx_concept_buzz_date ON concept_buzz(date DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_revenue_stock_date ON monthly_revenue(stock_id, date);

CREATE INDEX IF NOT EXISTS idx_margin_data_stock_date ON margin_data(stock_id, date);

CREATE INDEX IF NOT EXISTS idx_shareholding_stock_date ON shareholding(stock_id, date);

CREATE INDEX IF NOT EXISTS idx_stock_profiles_symbol ON stock_profiles(symbol);

CREATE INDEX IF NOT EXISTS idx_sfs_date_theme ON sector_flow_stocks(date, theme);

CREATE INDEX IF NOT EXISTS idx_sfs_date_class ON sector_flow_stocks(date, classification);

CREATE INDEX IF NOT EXISTS idx_momentum_snapshots_date
  ON screener_momentum_snapshots(date DESC);

CREATE INDEX IF NOT EXISTS idx_screener_hist_date   ON screener_selection_history(date DESC);

CREATE INDEX IF NOT EXISTS idx_screener_hist_symbol ON screener_selection_history(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_sector_leaders_symbol ON sector_leaders(symbol);

CREATE INDEX IF NOT EXISTS idx_stock_trading_restrictions_active_symbol
  ON stock_trading_restrictions(active, symbol);

CREATE INDEX IF NOT EXISTS idx_stock_trading_restrictions_dates
  ON stock_trading_restrictions(start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_ti_date_stock
  ON technical_indicators(date, stock_id);

CREATE INDEX IF NOT EXISTS idx_chip_date_symbol
  ON chip_data(date, symbol);

CREATE INDEX IF NOT EXISTS idx_sector_flow_date_class_total
  ON sector_flow(date, classification, total_net DESC);

CREATE INDEX IF NOT EXISTS idx_sector_flow_stocks_date_theme_class_net
  ON sector_flow_stocks(date, theme, classification, net_amount DESC);

CREATE INDEX IF NOT EXISTS idx_source_quality_metrics_source ON source_quality_metrics(source, dataset, as_of_date DESC);

CREATE INDEX IF NOT EXISTS idx_external_evidence_source_date ON external_evidence_items(source_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_external_evidence_accepted ON external_evidence_items(accepted, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_theme_signals_date_score ON theme_signals(date DESC, score DESC);

CREATE INDEX IF NOT EXISTS idx_theme_signals_concept ON theme_signals(concept, date DESC);

CREATE INDEX IF NOT EXISTS idx_stock_theme_features_date_score ON stock_theme_features(date DESC, score DESC);

CREATE INDEX IF NOT EXISTS idx_stock_theme_features_symbol ON stock_theme_features(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_flow_date
  ON canonical_broker_flow_daily(date DESC, market_segment);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_flow_symbol
  ON canonical_broker_flow_daily(stock_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_finlab_taxonomy_tags_symbol
  ON finlab_taxonomy_tags(symbol, tag_type);

CREATE INDEX IF NOT EXISTS idx_finlab_taxonomy_tags_tag
  ON finlab_taxonomy_tags(tag, tag_type);

CREATE INDEX IF NOT EXISTS idx_canonical_trading_restrictions_active
  ON canonical_trading_restrictions(active, source_date DESC, restriction_type);

CREATE INDEX IF NOT EXISTS idx_canonical_trading_restrictions_symbol
  ON canonical_trading_restrictions(symbol, source_date DESC);

CREATE INDEX IF NOT EXISTS idx_market_regime_factor_packets_generated
  ON market_regime_factor_packets(generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_market_date_stock
  ON canonical_market_daily(date DESC, stock_id);

CREATE INDEX IF NOT EXISTS idx_canonical_chip_date_segment_stock
  ON canonical_chip_daily(date DESC, market_segment, stock_id);

CREATE INDEX IF NOT EXISTS idx_canonical_revenue_month_stock
  ON canonical_revenue_monthly(revenue_month DESC, stock_id);

CREATE INDEX IF NOT EXISTS idx_margin_data_date_stock
  ON margin_data(date, stock_id);

CREATE INDEX IF NOT EXISTS idx_news_published_id
  ON news(published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_news_created_id
  ON news(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_institutional_amount_daily_date
  ON canonical_institutional_amount_daily(date DESC, market_segment, investor);

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_features_available
  ON canonical_fundamental_features(available_date DESC, stock_id);

CREATE INDEX IF NOT EXISTS idx_canonical_fundamental_features_symbol_period
  ON canonical_fundamental_features(stock_id, period DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_rank_date
  ON canonical_broker_rank_daily(date DESC, market_segment, rank_side);

CREATE INDEX IF NOT EXISTS idx_canonical_broker_rank_symbol
  ON canonical_broker_rank_daily(stock_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_institutional_amount_date
  ON canonical_institutional_amount_daily(date DESC, market_segment);

CREATE INDEX IF NOT EXISTS idx_canonical_market_index_symbol_date
  ON canonical_market_index_daily(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_futures_symbol_date
  ON canonical_futures_daily(symbol, session, date DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_regime_context_dataset_date
  ON canonical_regime_context_daily(dataset, date DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_regime_context_field_date
  ON canonical_regime_context_daily(field, category, date DESC);

CREATE INDEX IF NOT EXISTS idx_canonical_market_summary_daily_date
  ON canonical_market_summary_daily(date DESC);

CREATE INDEX IF NOT EXISTS idx_intraday_minute_bars_symbol_date
  ON intraday_minute_bars(symbol, trade_date, minute_start);
