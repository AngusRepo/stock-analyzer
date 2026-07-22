-- Capture the point-in-time learning universe before alpha selectors shrink it.
-- Large contexts remain in the screener R2 artifact referenced by producer_run_id.

CREATE TABLE IF NOT EXISTS selection_reference_snapshots_v1 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  stock_id INTEGER,
  name TEXT,
  market_segment TEXT,
  sector TEXT,
  hard_gate_passed INTEGER NOT NULL CHECK(hard_gate_passed IN (0, 1)),
  hard_gate_reason TEXT NOT NULL,
  feature_available INTEGER NOT NULL CHECK(feature_available IN (0, 1)),
  feature_rejection_reason TEXT,
  strategy_labeled INTEGER NOT NULL CHECK(strategy_labeled IN (0, 1)),
  strategy_selected INTEGER NOT NULL CHECK(strategy_selected IN (0, 1)),
  ml_selected INTEGER NOT NULL DEFAULT 0 CHECK(ml_selected IN (0, 1)),
  l4_selected INTEGER NOT NULL DEFAULT 0 CHECK(l4_selected IN (0, 1)),
  ev_owner_available INTEGER NOT NULL DEFAULT 0 CHECK(ev_owner_available IN (0, 1)),
  final_signal TEXT,
  selection_stage TEXT NOT NULL,
  rejection_reason TEXT,
  selection_propensity REAL,
  score_v2 REAL,
  score_components TEXT,
  allocation_selected INTEGER NOT NULL DEFAULT 0 CHECK(allocation_selected IN (0, 1)),
  decision_evidence_reconciled_at TEXT,
  strategy_labeler_version TEXT,
  strategy_router_version TEXT,
  strategy_registry_checksum TEXT NOT NULL,
  feature_contract_version TEXT NOT NULL,
  evidence_artifact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id)
);
CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_date
  ON selection_reference_snapshots_v1(signal_date, hard_gate_passed, strategy_selected);
CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_symbol
  ON selection_reference_snapshots_v1(symbol, signal_date DESC);

CREATE TABLE IF NOT EXISTS strategy_label_matrix_v4 (
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  strategy_status TEXT NOT NULL,
  alpha_bucket TEXT NOT NULL,
  family_id TEXT NOT NULL,
  production_owner INTEGER NOT NULL CHECK(production_owner IN (0, 1)),
  strategy_hit INTEGER NOT NULL CHECK(strategy_hit IN (0, 1)),
  weak_label REAL NOT NULL,
  affinity REAL NOT NULL,
  position_weight REAL NOT NULL,
  overlap REAL NOT NULL,
  label_reason TEXT,
  labeler_version TEXT NOT NULL,
  strategy_registry_checksum TEXT NOT NULL,
  reference_contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id, strategy_id, strategy_version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_date
  ON strategy_label_matrix_v4(signal_date, strategy_id, strategy_hit);
CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_symbol
  ON strategy_label_matrix_v4(symbol, signal_date DESC);

CREATE TABLE IF NOT EXISTS strategy_label_matrix_runs_v4 (
  producer_run_id TEXT PRIMARY KEY,
  signal_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing', 'ready', 'failed')),
  reference_candidate_count INTEGER NOT NULL,
  strategy_count INTEGER NOT NULL,
  expected_cell_count INTEGER NOT NULL,
  persisted_cell_count INTEGER NOT NULL DEFAULT 0,
  strategy_registry_checksum TEXT NOT NULL,
  labeler_version TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_runs_v4_date
  ON strategy_label_matrix_runs_v4(signal_date, status, updated_at DESC);
