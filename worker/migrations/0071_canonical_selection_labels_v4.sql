-- Selection outcomes are independent from trade execution outcomes. Never
-- coalesce these labels with predictions.trade_pnl_pct or legacy v2 rewards.

CREATE TABLE IF NOT EXISTS canonical_selection_labels_v4 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  label_schema_version TEXT NOT NULL DEFAULT 'canonical-strategy-selection-label-v4',
  producer_run_id TEXT NOT NULL,
  market_segment TEXT,
  sector TEXT,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  outcome_known_date TEXT NOT NULL,
  entry_raw_open REAL NOT NULL,
  exit_raw_close REAL NOT NULL,
  entry_adjustment_factor REAL NOT NULL,
  exit_adjustment_factor REAL NOT NULL,
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
  PRIMARY KEY(signal_date, symbol, producer_run_id, label_schema_version),
  CHECK(entry_date > signal_date),
  CHECK(exit_date >= entry_date),
  CHECK(outcome_known_date = exit_date)
);
CREATE INDEX IF NOT EXISTS idx_canonical_selection_labels_v4_known
  ON canonical_selection_labels_v4(outcome_known_date, signal_date);
CREATE INDEX IF NOT EXISTS idx_canonical_selection_labels_v4_symbol
  ON canonical_selection_labels_v4(symbol, signal_date DESC);

CREATE TABLE IF NOT EXISTS canonical_selection_label_rejections_v4 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id, reason_code)
);
CREATE INDEX IF NOT EXISTS idx_canonical_selection_label_rejections_v4_date
  ON canonical_selection_label_rejections_v4(signal_date, reason_code);

CREATE TABLE IF NOT EXISTS canonical_selection_label_runs_v4 (
  run_id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
  reference_rows INTEGER NOT NULL,
  mature_rows INTEGER NOT NULL,
  pending_rows INTEGER NOT NULL,
  unavailable_rows INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_canonical_selection_label_runs_v4_date
  ON canonical_selection_label_runs_v4(as_of_date, status, created_at DESC);
