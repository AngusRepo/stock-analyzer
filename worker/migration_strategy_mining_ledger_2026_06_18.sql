-- Strategy mining research/promotion ledger for monthly pymoo NSGA-III + novelty.
-- Local-prod-ready contract only; applying this migration does not promote any
-- strategy to production and does not alter strategy_spec_registry.

CREATE TABLE IF NOT EXISTS strategy_mining_runs (
  run_id TEXT PRIMARY KEY,
  run_date TEXT,
  cadence TEXT NOT NULL DEFAULT 'monthly',
  algorithm TEXT NOT NULL DEFAULT 'pymoo_nsga3_novelty',
  feature_registry_version TEXT NOT NULL,
  feature_pool_count INTEGER NOT NULL,
  core_prior_count INTEGER NOT NULL,
  evidence_watch_count INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  telemetry_json TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  decision_effect TEXT NOT NULL DEFAULT 'research_only',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategy_mining_candidates (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'pymoo_nsga3_novelty',
  factor_ids_json TEXT NOT NULL,
  factor_weights_json TEXT,
  family_id TEXT,
  novelty_score REAL,
  similarity_penalty REAL,
  max_pairwise_similarity REAL,
  validation_status TEXT NOT NULL DEFAULT 'research_candidate',
  promotion_state TEXT NOT NULL DEFAULT 'research_candidate',
  decision_effect TEXT NOT NULL DEFAULT 'none',
  metrics_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id)
);

CREATE TABLE IF NOT EXISTS strategy_backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'finlab',
  start_date TEXT,
  end_date TEXT,
  cagr REAL,
  sharpe REAL,
  max_drawdown REAL,
  calmar REAL,
  turnover REAL,
  pbo REAL,
  pbo_verdict TEXT,
  deflated_sharpe_probability REAL,
  walk_forward_verdict TEXT,
  hit_overlap REAL,
  l1_5_diversity_delta REAL,
  l2_l3_retention_delta REAL,
  l4_buy_stability REAL,
  decision TEXT NOT NULL DEFAULT 'research_only',
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(candidate_id) REFERENCES strategy_mining_candidates(candidate_id),
  FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id)
);

CREATE TABLE IF NOT EXISTS strategy_similarity_matrix (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  left_id TEXT NOT NULL,
  right_id TEXT NOT NULL,
  similarity REAL NOT NULL,
  similarity_method TEXT NOT NULL DEFAULT 'formal137_pairwise_abs_rank_corr',
  feature_overlap REAL,
  hit_overlap REAL,
  cluster_overlap REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, left_id, right_id),
  FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id)
);

CREATE TABLE IF NOT EXISTS strategy_promotion_ledger (
  ledger_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  decision TEXT NOT NULL,
  failed_gates_json TEXT NOT NULL DEFAULT '[]',
  packet_json TEXT NOT NULL,
  real_trading_effect TEXT NOT NULL DEFAULT 'none',
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(candidate_id) REFERENCES strategy_mining_candidates(candidate_id),
  FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_mining_runs_date
  ON strategy_mining_runs(run_date, cadence, status);
CREATE INDEX IF NOT EXISTS idx_strategy_mining_candidates_run
  ON strategy_mining_candidates(run_id, promotion_state, validation_status);
CREATE INDEX IF NOT EXISTS idx_strategy_backtest_results_candidate
  ON strategy_backtest_results(candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_similarity_matrix_run
  ON strategy_similarity_matrix(run_id, similarity DESC);
CREATE INDEX IF NOT EXISTS idx_strategy_promotion_ledger_candidate
  ON strategy_promotion_ledger(candidate_id, created_at DESC);
