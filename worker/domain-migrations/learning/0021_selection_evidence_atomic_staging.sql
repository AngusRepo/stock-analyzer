-- Durable, fenced staging for selection-reference + strategy-matrix replacement.
-- Canonical rows remain readable until a fully validated attempt is promoted by
-- one atomic D1 batch.

CREATE TABLE IF NOT EXISTS selection_evidence_staging_runs_v1 (
  producer_run_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  signal_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing', 'validated', 'promoted', 'failed')),
  expected_reference_count INTEGER NOT NULL,
  expected_strategy_count INTEGER NOT NULL,
  expected_cell_count INTEGER NOT NULL,
  staged_reference_count INTEGER NOT NULL DEFAULT 0,
  staged_cell_count INTEGER NOT NULL DEFAULT 0,
  strategy_registry_checksum TEXT NOT NULL,
  labeler_version TEXT NOT NULL,
  reference_contract_version TEXT NOT NULL,
  evidence_artifact_id TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_selection_evidence_staging_runs_v1_status
  ON selection_evidence_staging_runs_v1(status, updated_at);

CREATE TABLE IF NOT EXISTS selection_reference_snapshots_staging_v1 (
  attempt_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  stock_id INTEGER NOT NULL,
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
  strategy_labeler_version TEXT NOT NULL,
  strategy_affinity_version TEXT,
  strategy_router_version TEXT,
  strategy_router_score REAL,
  strategy_challenger_affinity_version TEXT,
  strategy_challenger_route_version TEXT,
  strategy_challenger_route_score REAL,
  strategy_registry_checksum TEXT NOT NULL,
  feature_contract_version TEXT NOT NULL,
  evidence_artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(attempt_id, signal_date, symbol, producer_run_id)
);

CREATE INDEX IF NOT EXISTS idx_selection_reference_staging_v1_attempt
  ON selection_reference_snapshots_staging_v1(attempt_id, producer_run_id, signal_date);

CREATE TABLE IF NOT EXISTS strategy_label_matrix_staging_v4 (
  attempt_id TEXT NOT NULL,
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
  affinity_version TEXT,
  match_strength REAL NOT NULL,
  threshold_margin REAL NOT NULL,
  affinity_evidence_count INTEGER NOT NULL,
  position_weight REAL NOT NULL,
  challenger_affinity REAL NOT NULL,
  challenger_affinity_version TEXT,
  challenger_position_weight REAL NOT NULL,
  overlap REAL NOT NULL,
  evaluable INTEGER NOT NULL CHECK(evaluable IN (0, 1)),
  evaluability_status TEXT NOT NULL,
  unavailable_reason TEXT,
  label_reason TEXT,
  labeler_version TEXT NOT NULL,
  strategy_registry_checksum TEXT NOT NULL,
  reference_contract_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(attempt_id, signal_date, symbol, producer_run_id, strategy_id, strategy_version)
);

CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_staging_v4_attempt
  ON strategy_label_matrix_staging_v4(attempt_id, producer_run_id, signal_date);
