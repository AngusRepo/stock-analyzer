-- Add runtime-owned tables deferred from the immutable domain baseline.
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

CREATE INDEX IF NOT EXISTS idx_canonical_institutional_amount_daily_date
  ON canonical_institutional_amount_daily(date DESC, market_segment, investor);

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
