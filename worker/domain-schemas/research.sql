-- Generated from schema.sql plus production snapshot fallback; do not edit by hand.
CREATE TABLE IF NOT EXISTS input_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('FEATURES','STRATEGIES','SYSTEM_PROFILE','RUN_MANIFEST')),
  version TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, snapshot_type)
);

CREATE INDEX IF NOT EXISTS idx_input_snapshots_run ON input_snapshots(run_id, snapshot_type);

CREATE TABLE IF NOT EXISTS feature_versions (
  feature_version TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  feature_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS features (
  feature_version TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  definition TEXT NOT NULL,
  data_source_json TEXT NOT NULL DEFAULT '[]',
  availability_lag TEXT NOT NULL,
  earliest_execution TEXT NOT NULL,
  lookback_days INTEGER,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  governance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(feature_version, feature_id)
);

CREATE INDEX IF NOT EXISTS idx_features_family ON features(feature_version, family);

CREATE TABLE IF NOT EXISTS strategy_versions (
  strategy_version TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  strategy_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategies (
  strategy_version TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  card_json TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_version, strategy_id)
);

CREATE INDEX IF NOT EXISTS idx_strategies_version ON strategies(strategy_version, strategy_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN (
    'CREATED','PREFLIGHT','RUNNING','CLOUD_ANALYSIS_COMPLETE','CODEX_HANDOFF_READY',
    'AWAITING_RESULT','RESULT_READY','FAILED_RECOVERABLE','BLOCKED'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  workflow_instance_id TEXT,
  workflow_attempt INTEGER NOT NULL DEFAULT 0,
  feature_version TEXT,
  strategy_version TEXT,
  feature_snapshot_hash TEXT,
  strategy_snapshot_hash TEXT,
  system_profile_hash TEXT,
  input_hash TEXT,
  prompt_set_version TEXT NOT NULL,
  schema_set_version TEXT NOT NULL,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 12,
  current_step TEXT,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  fixture_mode INTEGER NOT NULL DEFAULT 0 CHECK(fixture_mode IN (0,1)),
  error_code TEXT,
  error_detail TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_created_at ON analysis_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON analysis_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED','SKIPPED_REUSED')),
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  model_role TEXT,
  started_at TEXT,
  ended_at TEXT,
  error_code TEXT,
  error_detail TEXT,
  PRIMARY KEY(run_id, step_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_step ON workflow_steps(run_id, step_id);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  artifact_r2_key TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('COMPLETED','INVALIDATED')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_status ON workflow_checkpoints(run_id, status);

CREATE TABLE IF NOT EXISTS model_calls (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  raw_response_r2_key TEXT,
  parsed_response_r2_key TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  repair_count INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_model_calls_run_role ON model_calls(run_id, role);

CREATE INDEX IF NOT EXISTS idx_model_calls_date ON model_calls(started_at, source_type);

CREATE TABLE IF NOT EXISTS feature_clusters (
  run_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  cluster_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS gap_maps (
  run_id TEXT PRIMARY KEY,
  gap_map_json TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hypotheses (
  run_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL,
  search_mode TEXT NOT NULL,
  parent_strategy_id TEXT,
  source_model TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  hypothesis_json TEXT NOT NULL,
  hypothesis_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, hypothesis_id)
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_run_mode ON hypotheses(run_id, search_mode);

CREATE TABLE IF NOT EXISTS candidates (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  search_mode TEXT NOT NULL,
  parent_strategy_id TEXT,
  candidate_hash TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  source_model TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id),
  UNIQUE(run_id, candidate_hash)
);

CREATE INDEX IF NOT EXISTS idx_candidates_run_id ON candidates(run_id);

CREATE TABLE IF NOT EXISTS candidate_lineage (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  parent_strategy_id TEXT,
  mutation_type TEXT,
  search_mode TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS static_validation_results (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid IN (0,1)),
  errors_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  candidate_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS audit_issues (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_ids_json TEXT NOT NULL,
  category TEXT NOT NULL,
  severity_if_true TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  critic_model TEXT NOT NULL,
  critic_confidence REAL NOT NULL,
  cross_exam_status TEXT NOT NULL,
  duplicate_of TEXT,
  issue_json TEXT NOT NULL,
  issue_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_issues_run_target ON audit_issues(run_id, target_id);

CREATE INDEX IF NOT EXISTS idx_audit_issues_model ON audit_issues(run_id, critic_model);

CREATE TABLE IF NOT EXISTS cross_examinations (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  status TEXT NOT NULL,
  examination_json TEXT NOT NULL,
  source_model TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('REAL','FIXTURE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  artifact_hash TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  schema_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run_type ON artifacts(run_id, artifact_type);

CREATE TABLE IF NOT EXISTS codex_imports (
  import_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  zip_r2_key TEXT,
  error_json TEXT NOT NULL DEFAULT '[]',
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, result_hash),
  UNIQUE(run_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_codex_imports_run_id ON codex_imports(run_id);

CREATE TABLE IF NOT EXISTS strategy_verdicts (
  run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS candidate_verdicts (
  run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS issue_verdicts (
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  severity TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, issue_id)
);

CREATE TABLE IF NOT EXISTS backtest_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date        TEXT NOT NULL,
  strategy        TEXT NOT NULL,
  timerange       TEXT,
  total_trades    INTEGER,
  win_rate        REAL,
  sharpe          REAL,
  sortino         REAL,
  calmar          REAL,
  max_drawdown    REAL,
  cagr            REAL,
  profit_factor   REAL,
  expectancy      REAL,
  raw_results     TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, strategy, timerange)
);

CREATE TABLE IF NOT EXISTS monte_carlo_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date          TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'paper',
  n_simulations     INTEGER NOT NULL DEFAULT 1000,
  n_trades          INTEGER NOT NULL,
  historical_mdd    REAL,
  mdd_median        REAL,
  mdd_mean          REAL,
  mdd_std           REAL,
  mdd_95th          REAL,
  mdd_99th          REAL,
  mdd_worst         REAL,
  mdd_best          REAL,
  go_live_verdict   TEXT,
  verdict_reason    TEXT,
  raw_distribution  TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, source)
);

CREATE TABLE IF NOT EXISTS pbo_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date          TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'backtest',
  n_partitions      INTEGER NOT NULL DEFAULT 10,
  n_combinations    INTEGER NOT NULL,
  n_trades          INTEGER NOT NULL,
  pbo               REAL NOT NULL,
  n_oos_negative    INTEGER NOT NULL,
  oos_mean_return   REAL,
  is_mean_return    REAL,
  degradation       REAL,
  go_live_verdict   TEXT,
  verdict_reason    TEXT,
  raw_details       TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(run_date, source)
);

CREATE TABLE IF NOT EXISTS pbo_attempt_receipts (
  attempt_id               TEXT PRIMARY KEY,
  run_date                 TEXT NOT NULL,
  source                   TEXT NOT NULL DEFAULT 'backtest',
  status                   TEXT NOT NULL CHECK (status IN ('computed', 'insufficient_evidence')),
  n_partitions             INTEGER NOT NULL CHECK (n_partitions >= 4),
  observed_trades          INTEGER NOT NULL CHECK (observed_trades >= 0),
  required_trades          INTEGER NOT NULL CHECK (required_trades > 0),
  source_provenance_json   TEXT NOT NULL CHECK (json_valid(source_provenance_json)),
  pbo_result_id            INTEGER,
  production_effect        INTEGER NOT NULL DEFAULT 0 CHECK (production_effect = 0),
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (status = 'insufficient_evidence' AND pbo_result_id IS NULL)
    OR (status = 'computed' AND pbo_result_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pbo_attempt_receipts_latest
  ON pbo_attempt_receipts(run_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS debate_ab_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  date              TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  model_assigned    TEXT NOT NULL,
  model_actual      TEXT,
  verdict           TEXT,
  conviction_score  REAL,
  summary_len       INTEGER,
  debate_rounds     INTEGER,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  meta              TEXT
);

CREATE TABLE IF NOT EXISTS strategy_mining_runs ( run_id TEXT PRIMARY KEY, run_date TEXT, cadence TEXT NOT NULL DEFAULT 'monthly', algorithm TEXT NOT NULL DEFAULT 'pymoo_nsga3_novelty', feature_registry_version TEXT NOT NULL, feature_pool_count INTEGER NOT NULL, core_prior_count INTEGER NOT NULL, evidence_watch_count INTEGER NOT NULL, config_json TEXT NOT NULL, telemetry_json TEXT, status TEXT NOT NULL DEFAULT 'created', decision_effect TEXT NOT NULL DEFAULT 'research_only', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );

CREATE TABLE IF NOT EXISTS strategy_mining_candidates ( candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, algorithm TEXT NOT NULL DEFAULT 'pymoo_nsga3_novelty', factor_ids_json TEXT NOT NULL, factor_weights_json TEXT, family_id TEXT, novelty_score REAL, similarity_penalty REAL, max_pairwise_similarity REAL, validation_status TEXT NOT NULL DEFAULT 'research_candidate', promotion_state TEXT NOT NULL DEFAULT 'research_candidate', decision_effect TEXT NOT NULL DEFAULT 'none', metrics_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );

CREATE TABLE IF NOT EXISTS strategy_backtest_results ( id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, run_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'finlab', start_date TEXT, end_date TEXT, cagr REAL, sharpe REAL, max_drawdown REAL, calmar REAL, turnover REAL, pbo REAL, pbo_verdict TEXT, deflated_sharpe_probability REAL, walk_forward_verdict TEXT, hit_overlap REAL, l1_5_diversity_delta REAL, l2_l3_retention_delta REAL, l4_buy_stability REAL, decision TEXT NOT NULL DEFAULT 'research_only', evidence_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(candidate_id) REFERENCES strategy_mining_candidates(candidate_id), FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );

CREATE TABLE IF NOT EXISTS strategy_similarity_matrix ( id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, left_id TEXT NOT NULL, right_id TEXT NOT NULL, similarity REAL NOT NULL, similarity_method TEXT NOT NULL DEFAULT 'formal137_pairwise_abs_rank_corr', feature_overlap REAL, hit_overlap REAL, cluster_overlap REAL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(run_id, left_id, right_id), FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );

CREATE TABLE IF NOT EXISTS strategy_promotion_ledger ( ledger_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, run_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, decision TEXT NOT NULL, failed_gates_json TEXT NOT NULL DEFAULT '[]', packet_json TEXT NOT NULL, real_trading_effect TEXT NOT NULL DEFAULT 'none', approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(candidate_id) REFERENCES strategy_mining_candidates(candidate_id), FOREIGN KEY(run_id) REFERENCES strategy_mining_runs(run_id) );

CREATE TABLE IF NOT EXISTS active_strategy_backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  strategy_scope TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'finlab_strategy_spec_backtest',
  start_date TEXT,
  end_date TEXT,
  cagr REAL,
  sharpe REAL,
  max_drawdown REAL,
  calmar REAL,
  turnover REAL,
  signal_status TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_debate_ab_date   ON debate_ab_log(date DESC);

CREATE INDEX IF NOT EXISTS idx_debate_ab_model  ON debate_ab_log(model_assigned, date DESC);

CREATE INDEX IF NOT EXISTS idx_debate_ab_symbol ON debate_ab_log(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_mining_runs_date ON strategy_mining_runs(run_date, cadence, status);

CREATE INDEX IF NOT EXISTS idx_strategy_mining_candidates_run ON strategy_mining_candidates(run_id, promotion_state, validation_status);

CREATE INDEX IF NOT EXISTS idx_strategy_backtest_results_candidate ON strategy_backtest_results(candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_similarity_matrix_run ON strategy_similarity_matrix(run_id, similarity DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_promotion_ledger_candidate ON strategy_promotion_ledger(candidate_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_active_strategy_backtest_results_strategy
  ON active_strategy_backtest_results(strategy_id, run_id, created_at DESC);
