-- Multi-LLM Strategy Discovery & Adversarial Audit Lab
-- Research/audit-only control plane. Does not reference production trading tables.

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

CREATE TABLE IF NOT EXISTS model_accuracy (
  run_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  role TEXT NOT NULL,
  proposed_count INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  refuted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,
  unique_confirmed_count INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, model_id, role)
);
