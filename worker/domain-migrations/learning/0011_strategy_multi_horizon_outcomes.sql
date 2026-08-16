CREATE TABLE IF NOT EXISTS price_horizon_labels_v2 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK(horizon_days IN (3,5,10)),
  entry_date TEXT NOT NULL,
  entry_raw_open REAL NOT NULL,
  entry_adjustment_factor REAL NOT NULL,
  exit_date TEXT NOT NULL,
  exit_raw_close REAL NOT NULL,
  exit_adjustment_factor REAL NOT NULL,
  outcome_known_date TEXT NOT NULL,
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  materialized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, price_date, horizon_days),
  CHECK(entry_date > price_date),
  CHECK(exit_date >= entry_date),
  CHECK(outcome_known_date = exit_date),
  CHECK(entry_raw_open > 0), CHECK(exit_raw_close > 0),
  CHECK(entry_adjustment_factor > 0), CHECK(exit_adjustment_factor > 0)
);
CREATE INDEX IF NOT EXISTS idx_price_horizon_labels_v2_known
  ON price_horizon_labels_v2(horizon_days, outcome_known_date, price_date);

CREATE TABLE IF NOT EXISTS price_horizon_label_rejections_v2 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK(horizon_days IN (3,5,10)),
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, price_date, horizon_days)
);
CREATE INDEX IF NOT EXISTS idx_price_horizon_rejections_v2_date
  ON price_horizon_label_rejections_v2(horizon_days, price_date, rejection_reason);

CREATE TABLE IF NOT EXISTS canonical_selection_outcomes_v1 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  horizon_days INTEGER NOT NULL CHECK(horizon_days IN (3,5,10)),
  label_schema_version TEXT NOT NULL DEFAULT 'canonical-strategy-selection-outcome-v1',
  market_segment TEXT,
  sector TEXT,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  outcome_known_date TEXT NOT NULL,
  gross_return REAL NOT NULL,
  transaction_cost_bps REAL NOT NULL,
  absolute_return_net REAL NOT NULL,
  benchmark_return_net REAL NOT NULL,
  benchmark_scope TEXT NOT NULL CHECK(benchmark_scope IN ('sector','market_segment','market')),
  residual_return_net REAL NOT NULL,
  cross_section_rank REAL NOT NULL,
  adjustment_source TEXT NOT NULL,
  reference_contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id, horizon_days, label_schema_version),
  CHECK(entry_date > signal_date),
  CHECK(exit_date >= entry_date),
  CHECK(outcome_known_date = exit_date)
);
CREATE INDEX IF NOT EXISTS idx_canonical_selection_outcomes_v1_known
  ON canonical_selection_outcomes_v1(horizon_days, outcome_known_date, signal_date);
CREATE INDEX IF NOT EXISTS idx_canonical_selection_outcomes_v1_strategy_join
  ON canonical_selection_outcomes_v1(signal_date, symbol, producer_run_id, horizon_days);
