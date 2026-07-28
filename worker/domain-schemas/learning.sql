-- Generated from schema.sql; do not edit by hand.
CREATE TABLE IF NOT EXISTS predictions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id           INTEGER NOT NULL,
  model_name         TEXT NOT NULL,
  generated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  prediction_date    TEXT,
  horizon            INTEGER DEFAULT 30,
  rmse               REAL, mape REAL, direction_accuracy REAL,
  best_model         INTEGER DEFAULT 0,
  forecast_data      TEXT,
  entry_price        REAL, stop_loss REAL,
  target1            REAL, target2 REAL,
  trade_signal       TEXT DEFAULT 'hold' CHECK(trade_signal IN ('buy','sell','hold')),

  predicted_direction TEXT,
  predicted_price     REAL,
  actual_direction    TEXT,
  actual_price        REAL,
  direction_correct   INTEGER,
  price_error_pct     REAL,
  verified_at         TEXT,

  market_risk_level   TEXT,
  market_risk_score   INTEGER,

  feature_version     TEXT,

  actual_return_pct   REAL,
  trade_outcome       TEXT,
  trade_pnl_pct       REAL,
  trade_pnl_r         REAL,
  max_favorable_pct   REAL,
  max_adverse_pct     REAL,
  verification_label_schema_version TEXT,
  verification_label_entry_price REAL,
  verification_label_end_date TEXT,
  verification_label_known_date TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pred_stock    ON predictions(stock_id, model_name);

CREATE INDEX IF NOT EXISTS idx_predictions_business_date ON predictions(prediction_date, stock_id, model_name);

CREATE INDEX IF NOT EXISTS idx_pred_verify   ON predictions(stock_id, verified_at);

CREATE INDEX IF NOT EXISTS idx_pred_unverify ON predictions(stock_id, direction_correct) WHERE direction_correct IS NULL;

CREATE TABLE IF NOT EXISTS s12_replay_trade_outcomes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                TEXT NOT NULL,
  market                TEXT,
  trade_date            TEXT NOT NULL,
  assessment_state      TEXT,
  setup_id              TEXT,
  entry_ms              INTEGER,
  exit_ms               INTEGER,
  entry_price           REAL,
  stop_price            REAL,
  target1_price         REAL,
  target2_price         REAL,
  target3_price         REAL,
  exit_price            REAL,
  pnl_pct               REAL,
  trade_pnl_r           REAL,
  max_favorable_pct     REAL,
  max_adverse_pct       REAL,
  bars_to_exit          INTEGER,
  exit_reason           TEXT,
  sample_eligible       INTEGER NOT NULL DEFAULT 0,
  source                TEXT NOT NULL DEFAULT 's12_intraday_structure_replay_v1',
  detail_json           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol, trade_date, setup_id)
);

CREATE INDEX IF NOT EXISTS idx_s12_replay_trade_outcomes_date
  ON s12_replay_trade_outcomes(trade_date DESC, sample_eligible, symbol);

CREATE TABLE IF NOT EXISTS s12_structure_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date            TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 's12_intraday_structure_v1',
  side                  TEXT,
  state                 TEXT,
  ready                 INTEGER NOT NULL DEFAULT 0,
  invalidated           INTEGER NOT NULL DEFAULT 0,
  setup_id              TEXT,
  entry_price           REAL,
  chase_ceiling         REAL,
  structure_stop        REAL,
  target1_price         REAL,
  target2_price         REAL,
  target3_price         REAL,
  target4_price         REAL,
  demand_zone_low       REAL,
  demand_zone_high      REAL,
  supply_zone_low       REAL,
  supply_zone_high      REAL,
  detail                TEXT,
  entry_context_json    TEXT,
  exit_plan_json        TEXT,
  raw_json              TEXT,
  pending_run_id        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trade_date, symbol, source)
);

CREATE INDEX IF NOT EXISTS idx_s12_structure_snapshots_date_symbol
  ON s12_structure_snapshots(trade_date DESC, symbol);

CREATE TABLE IF NOT EXISTS s12_tw_calibration_runs (
  run_id               TEXT PRIMARY KEY,
  run_date             TEXT NOT NULL,
  cadence              TEXT NOT NULL,
  status               TEXT NOT NULL,
  scopes_seen          INTEGER NOT NULL DEFAULT 0,
  artifacts_written    INTEGER NOT NULL DEFAULT 0,
  summary_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS s12_tw_calibration_artifacts (
  artifact_id          TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL,
  status               TEXT NOT NULL,
  cadence              TEXT NOT NULL,
  market_segment       TEXT NOT NULL,
  entry_cohort        TEXT NOT NULL DEFAULT 'legacy_mixed',
  alpha_bucket         TEXT,
  entry_time_bucket    TEXT,
  policy_json          TEXT NOT NULL,
  exit_json            TEXT NOT NULL,
  validation_start     TEXT NOT NULL,
  validation_end       TEXT NOT NULL,
  sample_count         INTEGER NOT NULL,
  date_count           INTEGER NOT NULL,
  metrics_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at          TEXT,
  superseded_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_s12_tw_calibration_active
  ON s12_tw_calibration_artifacts(
    status,
    superseded_at,
    market_segment,
    alpha_bucket,
    entry_time_bucket,
    approved_at DESC
  );

CREATE TABLE IF NOT EXISTS state_space_shadow_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'modal_state_space_shadow',
  model_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  stock_id INTEGER,
  horizon INTEGER,
  forecast_pct REAL,
  up_prob REAL,
  confidence REAL,
  direction TEXT,
  model_version TEXT,
  n_used INTEGER,
  degraded INTEGER NOT NULL DEFAULT 0,
  fallback_reason TEXT,
  error TEXT,
  diagnostics_json TEXT,
  overlay_json TEXT NOT NULL,
  callback_json TEXT,
  function_call_id TEXT,
  elapsed_s REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_date, run_id, model_name, symbol)
);

CREATE INDEX IF NOT EXISTS idx_state_space_shadow_run
  ON state_space_shadow_results(run_date, run_id);

CREATE INDEX IF NOT EXISTS idx_state_space_shadow_model_symbol
  ON state_space_shadow_results(model_name, symbol, run_date);

CREATE INDEX IF NOT EXISTS idx_state_space_shadow_errors
  ON state_space_shadow_results(run_date, model_name, error, fallback_reason);

CREATE TABLE IF NOT EXISTS model_accuracy (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL,
  model_name   TEXT NOT NULL,
  period       TEXT NOT NULL DEFAULT 'all',
  total_count  INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  accuracy     REAL NOT NULL DEFAULT 0.5,
  avg_price_error REAL,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),

  accuracy_in_low_risk    REAL,
  accuracy_in_high_risk   REAL,
  count_low_risk          INTEGER DEFAULT 0,
  count_high_risk         INTEGER DEFAULT 0,

  avg_win_pct       REAL,
  avg_loss_pct      REAL,
  profit_factor     REAL,
  avg_trade_pnl     REAL,
  avg_trade_pnl_r   REAL,
  hit_target_rate   REAL,
  hit_stop_rate     REAL,
  expectancy        REAL,
  UNIQUE(stock_id, model_name, period)
);

CREATE INDEX IF NOT EXISTS idx_model_acc ON model_accuracy(stock_id, model_name);

CREATE TABLE IF NOT EXISTS stock_memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id   INTEGER NOT NULL,
  memory_type TEXT NOT NULL,
  content    TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  sample_count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_stock ON stock_memories(stock_id, memory_type);

CREATE TABLE IF NOT EXISTS trade_performance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL,
  model_name   TEXT NOT NULL,
  period       TEXT NOT NULL DEFAULT 'all',

  total_trades    INTEGER DEFAULT 0,
  win_trades      INTEGER DEFAULT 0,
  loss_trades     INTEGER DEFAULT 0,

  total_pnl_pct   REAL,
  avg_win_pct     REAL,
  avg_loss_pct    REAL,
  max_win_pct     REAL,
  max_loss_pct    REAL,
  profit_factor   REAL,
  expectancy      REAL,

  avg_pnl_r       REAL,

  hit_target1_count INTEGER DEFAULT 0,
  hit_target2_count INTEGER DEFAULT 0,
  hit_stop_count    INTEGER DEFAULT 0,
  expired_count     INTEGER DEFAULT 0,

  avg_mfe         REAL,
  avg_mae         REAL,
  last_updated    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stock_id, model_name, period)
);

CREATE INDEX IF NOT EXISTS idx_trade_perf ON trade_performance(stock_id, model_name);

CREATE TABLE IF NOT EXISTS dataset_snapshots (
  snapshot_id     TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  business_date   TEXT NOT NULL,
  market_segment  TEXT,
  schema_version  TEXT NOT NULL,
  row_count       INTEGER NOT NULL DEFAULT 0,
  checksum        TEXT NOT NULL,
  primary_store   TEXT NOT NULL CHECK(primary_store IN ('d1','gcs','r2')),
  access_tier     TEXT NOT NULL CHECK(access_tier IN ('serving','compute','report','preview','archive')),
  gcs_uri         TEXT,
  r2_key          TEXT,
  producer_run_id TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('pending','ready','failed','expired')),
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_kind_date
  ON dataset_snapshots(kind, business_date DESC, status);

CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_access_date
  ON dataset_snapshots(access_tier, business_date DESC, primary_store);

CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_run
  ON dataset_snapshots(producer_run_id, kind);

CREATE TABLE IF NOT EXISTS model_artifact_registry (
  artifact_id                 TEXT PRIMARY KEY,
  model_name                  TEXT NOT NULL,
  version                     TEXT NOT NULL,
  candidate_type              TEXT NOT NULL CHECK(candidate_type IN ('monthly_release','weekly_drift','oof_full_fit_release','manual_hotfix','model_family_shadow','research_benchmark','timesfm_l175_l2_feature_release','l4_alpha_ev_refresh','allocator_ev_fusion_refresh','unknown')),
  state                       TEXT NOT NULL CHECK(state IN (
    'registered',
    'registration_failed',
    'offline_failed',
    'offline_passed_weak',
    'offline_passed',
    'offline_strong_pass',
    'candidate_selected',
    'shadowing',
    'live_gate_passed',
    'approval_required',
    'approved',
    'production',
    'rejected',
    'archived'
  )),
  artifact_path               TEXT,
  metadata_path               TEXT,
  training_run_id             TEXT,
  training_manifest_path      TEXT,
  trained_from_snapshot       TEXT,
  evaluation_baseline_version TEXT,
  final_compared_to           TEXT,
  feature_policy_version      TEXT,
  checksum                    TEXT,
  source_run_date             TEXT,
  is_monthly                  INTEGER NOT NULL DEFAULT 0,
  offline_gate_status         TEXT NOT NULL DEFAULT 'not_evaluated',
  offline_gate_decision       TEXT NOT NULL DEFAULT 'PENDING',
  offline_gate_failed_gates   TEXT NOT NULL DEFAULT '[]',
  offline_evidence_json       TEXT NOT NULL DEFAULT '{}',
  live_gate_status            TEXT NOT NULL DEFAULT 'not_started',
  live_evidence_json          TEXT NOT NULL DEFAULT '{}',
  promotion_decision          TEXT NOT NULL DEFAULT 'not_evaluated',
  approval_state              TEXT NOT NULL DEFAULT 'not_required',
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_name, version, candidate_type)
);

CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_model_state
  ON model_artifact_registry(model_name, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_candidate_type
  ON model_artifact_registry(candidate_type, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_run
  ON model_artifact_registry(training_run_id, source_run_date);

CREATE TABLE IF NOT EXISTS model_champion_history (
  event_id       TEXT PRIMARY KEY,
  model_name     TEXT NOT NULL,
  version        TEXT NOT NULL,
  artifact_id    TEXT,
  effective_at   TEXT NOT NULL,
  retired_at     TEXT,
  source         TEXT NOT NULL CHECK(source = 'model_champion_history'),
  evidence_grade TEXT NOT NULL CHECK(evidence_grade IN ('exact','bounded','unknown')),
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_name, version, effective_at)
);

CREATE INDEX IF NOT EXISTS idx_model_champion_history_asof
  ON model_champion_history(model_name, effective_at, retired_at);

CREATE TABLE IF NOT EXISTS model_champion_pointers (
  model_name                  TEXT PRIMARY KEY,
  champion_version            TEXT NOT NULL,
  champion_artifact_id        TEXT,
  rollback_version            TEXT,
  rollback_artifact_id        TEXT,
  promoted_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promotion_reason            TEXT,
  promotion_evidence_json     TEXT NOT NULL DEFAULT '{}',
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_model_champion_pointers_updated
  ON model_champion_pointers(updated_at DESC);

CREATE TABLE IF NOT EXISTS expected_return_artifact_payloads (
  artifact_id TEXT PRIMARY KEY,
  model_name TEXT NOT NULL CHECK(model_name IN ('l4_alpha_ev','allocator_ev_fusion')),
  model_version TEXT NOT NULL,
  serving_mode TEXT NOT NULL CHECK(serving_mode IN ('alpha','abstention_baseline')),
  artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
  source_artifact_path TEXT,
  source_artifact_checksum TEXT,
  source_cohort_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(artifact_id) REFERENCES model_artifact_registry(artifact_id) ON DELETE RESTRICT,
  UNIQUE(model_name, model_version)
);

CREATE INDEX IF NOT EXISTS idx_expected_return_artifact_payloads_owner
  ON expected_return_artifact_payloads(model_name, serving_mode, updated_at DESC);

CREATE TABLE IF NOT EXISTS allocator_ev_feature_snapshots (
  snapshot_date               TEXT NOT NULL,
  stock_id                    INTEGER NOT NULL,
  symbol                      TEXT NOT NULL,
  forecast_data               TEXT,
  score                       REAL,
  score_components            TEXT,
  alpha_context               TEXT,
  alpha_allocation            TEXT NOT NULL,
  market_heat_expected_return REAL,
  market_segment              TEXT,
  recommendation_lane         TEXT,
  snapshot_source             TEXT NOT NULL DEFAULT 'allocator_ev_asof_backfill_v2',
  l4_model_version            TEXT,
  s12_source                  TEXT,
  as_of_guard                 TEXT NOT NULL,
  source_recommendation_date  TEXT,
  lineage_cohort_id           TEXT,
  generation_mode             TEXT NOT NULL DEFAULT 'native',
  model_set_signature         TEXT,
  target_semantic_version     TEXT,
  generated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_date, stock_id, snapshot_source)
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshots_date
  ON allocator_ev_feature_snapshots(snapshot_date, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshots_symbol
  ON allocator_ev_feature_snapshots(symbol, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS allocator_ev_snapshot_runs (
  run_id TEXT PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  snapshot_source TEXT NOT NULL,
  as_of_guard TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing','ready','failed')),
  expected_rows INTEGER NOT NULL DEFAULT 0,
  staged_rows INTEGER NOT NULL DEFAULT 0,
  published_rows INTEGER NOT NULL DEFAULT 0,
  native_lineage_rows INTEGER NOT NULL DEFAULT 0,
  reconstructed_lineage_rows INTEGER NOT NULL DEFAULT 0,
  rejected_lineage_rows INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshot_runs_date_status
  ON allocator_ev_snapshot_runs(snapshot_date DESC, snapshot_source, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS allocator_ev_feature_snapshot_staging (
  run_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  stock_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  forecast_data TEXT,
  score REAL,
  score_components TEXT,
  alpha_context TEXT,
  alpha_allocation TEXT NOT NULL,
  market_heat_expected_return REAL,
  market_segment TEXT,
  recommendation_lane TEXT,
  snapshot_source TEXT NOT NULL,
  l4_model_version TEXT,
  s12_source TEXT,
  as_of_guard TEXT NOT NULL,
  source_recommendation_date TEXT,
  lineage_cohort_id TEXT,
  generation_mode TEXT NOT NULL DEFAULT 'native',
  model_set_signature TEXT,
  target_semantic_version TEXT,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, stock_id),
  FOREIGN KEY (run_id) REFERENCES allocator_ev_snapshot_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_snapshot_staging_run
  ON allocator_ev_feature_snapshot_staging(run_id, snapshot_date, stock_id);

CREATE TABLE IF NOT EXISTS active8_oof_cohorts (
  cohort_id TEXT PRIMARY KEY,
  generation_mode TEXT NOT NULL CHECK(generation_mode = 'purged_oof'),
  status TEXT NOT NULL CHECK(status IN ('building','ready','failed','retired')),
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  model_set_signature TEXT NOT NULL,
  expected_models INTEGER NOT NULL DEFAULT 8,
  expected_folds INTEGER NOT NULL,
  completed_folds INTEGER NOT NULL DEFAULT 0,
  prediction_rows INTEGER NOT NULL DEFAULT 0,
  prediction_dates INTEGER NOT NULL DEFAULT 0,
  artifact_manifest_path TEXT,
  artifact_manifest_checksum TEXT,
  prediction_storage_mode TEXT NOT NULL DEFAULT 'd1_full_v1',
  parent_cohort_id TEXT,
  parent_manifest_checksum TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active8_oof_fold_artifacts (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  source_cohort_id TEXT NOT NULL,
  source_manifest_checksum TEXT NOT NULL,
  model_name TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  artifact_rows INTEGER NOT NULL DEFAULT 0,
  prediction_dates INTEGER NOT NULL DEFAULT 0,
  train_start TEXT NOT NULL,
  train_end TEXT NOT NULL,
  test_start TEXT NOT NULL,
  test_end TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, model_name),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(train_end < test_start)
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_fold_artifacts_source
  ON active8_oof_fold_artifacts(source_cohort_id, fold_id, model_name);

CREATE TABLE IF NOT EXISTS active8_oof_materialized_artifacts (
  cohort_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('allocator_ev_snapshots','l4_predictions')),
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  format_version TEXT NOT NULL CHECK(format_version = 'active8-oof-materialized-jsonl-gzip-v1'),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  date_count INTEGER NOT NULL CHECK(date_count >= 0),
  min_date TEXT,
  max_date TEXT,
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes >= 0),
  uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 0),
  source_manifest_checksum TEXT NOT NULL,
  eligibility_policy_version TEXT NOT NULL DEFAULT 'legacy-unversioned',
  date_set_checksum TEXT,
  replacement_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, artifact_kind),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(min_date IS NULL OR max_date IS NULL OR min_date <= max_date)
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_materialized_artifacts_checksum
  ON active8_oof_materialized_artifacts(artifact_checksum);

CREATE TABLE IF NOT EXISTS active8_oof_materialized_artifact_history (
  cohort_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('allocator_ev_snapshots','l4_predictions')),
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  format_version TEXT NOT NULL CHECK(format_version = 'active8-oof-materialized-jsonl-gzip-v1'),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  date_count INTEGER NOT NULL CHECK(date_count >= 0),
  min_date TEXT,
  max_date TEXT,
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes >= 0),
  uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 0),
  source_manifest_checksum TEXT NOT NULL,
  eligibility_policy_version TEXT NOT NULL,
  date_set_checksum TEXT,
  replaced_by_checksum TEXT NOT NULL,
  replacement_reason TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, artifact_kind, artifact_checksum),
  CHECK(length(artifact_checksum) = 64),
  CHECK(length(source_manifest_checksum) = 64),
  CHECK(length(replaced_by_checksum) = 64),
  CHECK(date_set_checksum IS NULL OR length(date_set_checksum) = 64)
);

CREATE INDEX IF NOT EXISTS idx_oof_materialized_history_replacement
  ON active8_oof_materialized_artifact_history(cohort_id, artifact_kind, replaced_by_checksum);

CREATE TABLE IF NOT EXISTS active8_oof_predictions (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  stock_id INTEGER,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  model_name TEXT NOT NULL,
  raw_score REAL NOT NULL,
  rank_score REAL NOT NULL CHECK(rank_score >= 0.0 AND rank_score <= 1.0),
  target_return REAL NOT NULL,
  label_known_date TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  train_start TEXT NOT NULL,
  train_end TEXT NOT NULL,
  test_start TEXT NOT NULL,
  test_end TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  score_semantic_version TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, prediction_date, symbol, market_segment, model_name),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(label_known_date > prediction_date)
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_predictions_cohort_date
  ON active8_oof_predictions(cohort_id, prediction_date, model_name);

CREATE TABLE IF NOT EXISTS allocator_ev_oof_snapshots (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  stock_id INTEGER,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  forecast_data TEXT NOT NULL,
  score REAL,
  score_components TEXT,
  alpha_context TEXT,
  alpha_allocation TEXT NOT NULL,
  market_heat_expected_return REAL,
  recommendation_lane TEXT,
  l4_model_version TEXT,
  s12_source TEXT,
  s12_asof_date TEXT NOT NULL,
  label_known_date TEXT NOT NULL,
  model_set_signature TEXT NOT NULL,
  target_semantic_version TEXT NOT NULL,
  generation_mode TEXT NOT NULL CHECK(generation_mode = 'purged_oof'),
  source_manifest_checksum TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, snapshot_date, symbol, market_segment),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(s12_asof_date <= snapshot_date),
  CHECK(label_known_date > snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_allocator_ev_oof_snapshots_cohort_date
  ON allocator_ev_oof_snapshots(cohort_id, snapshot_date);

CREATE TABLE IF NOT EXISTS l4_oof_predictions (
  cohort_id TEXT NOT NULL,
  fold_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market_segment TEXT NOT NULL,
  expected_return REAL NOT NULL,
  prediction_json TEXT NOT NULL,
  trained_until TEXT NOT NULL,
  model_version TEXT NOT NULL,
  eligible_for_efficacy INTEGER NOT NULL CHECK(eligible_for_efficacy IN (0, 1)),
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cohort_id, fold_id, prediction_date, symbol, market_segment),
  FOREIGN KEY (cohort_id) REFERENCES active8_oof_cohorts(cohort_id) ON DELETE RESTRICT,
  CHECK(trained_until < prediction_date)
);

CREATE INDEX IF NOT EXISTS idx_l4_oof_predictions_cohort_date
  ON l4_oof_predictions(cohort_id, prediction_date);

CREATE TABLE IF NOT EXISTS active8_oof_date_eligibility (
  cohort_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  evidence_scope TEXT NOT NULL CHECK(evidence_scope IN ('active8_oof','snapshot','l4','fusion')),
  eligibility_status TEXT NOT NULL CHECK(eligibility_status IN ('legal','illegal','pending')),
  reason_code TEXT NOT NULL,
  evidence_schema_version TEXT NOT NULL,
  source_manifest_checksum TEXT,
  evidence_artifact_path TEXT,
  evidence_artifact_checksum TEXT,
  assessed_knowledge_cutoff TEXT NOT NULL,
  assessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(cohort_id, prediction_date, evidence_scope)
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_date_eligibility_status
  ON active8_oof_date_eligibility(evidence_scope, eligibility_status, prediction_date, cohort_id);

CREATE TABLE IF NOT EXISTS active8_oof_retention_ledger (
  cohort_id TEXT PRIMARY KEY,
  legality_state TEXT NOT NULL CHECK(legality_state IN ('legal','mixed','illegal','pending')),
  retention_action TEXT NOT NULL CHECK(retention_action IN ('retain_hot','archive_required','archive_only','delete_hot')),
  status TEXT NOT NULL CHECK(status IN ('planned','blocked','archived','verified','deleted','error')),
  d1_prediction_rows INTEGER NOT NULL DEFAULT 0,
  d1_snapshot_rows INTEGER NOT NULL DEFAULT 0,
  d1_l4_rows INTEGER NOT NULL DEFAULT 0,
  hard_reference_count INTEGER NOT NULL DEFAULT 0,
  archive_store TEXT CHECK(archive_store IN ('r2','gcs')),
  archive_path TEXT,
  archive_checksum TEXT,
  archive_row_count INTEGER,
  archive_verified_at TEXT,
  blocker_reason TEXT,
  planned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_retention_action_status
  ON active8_oof_retention_ledger(retention_action, status, hard_reference_count);

CREATE TABLE IF NOT EXISTS strategy_spec_registry (
  strategy_id              TEXT NOT NULL,
  version                  TEXT NOT NULL,
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('research','shadow','candidate','active','retired')),
  owner                    TEXT NOT NULL DEFAULT 'strategy',
  alpha_bucket             TEXT NOT NULL,
  family_id                TEXT NOT NULL DEFAULT 'TREND_RECLAIM_CONTINUATION',
  variant_id               TEXT NOT NULL DEFAULT '',
  owner_type               TEXT NOT NULL DEFAULT 'strategy',
  promotion_status         TEXT NOT NULL DEFAULT 'production',
  supported_regimes_json   TEXT NOT NULL DEFAULT '[]',
  thesis                   TEXT NOT NULL,
  thresholds_json          TEXT NOT NULL DEFAULT '{}',
  candidate_policy_json    TEXT NOT NULL DEFAULT '{}',
  risk_notes_json          TEXT NOT NULL DEFAULT '[]',
  source_refs_json         TEXT NOT NULL DEFAULT '[]',
  created_by               TEXT NOT NULL DEFAULT 'p5_strategy_governance',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(strategy_id, version)
);

CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_status
  ON strategy_spec_registry(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_bucket
  ON strategy_spec_registry(alpha_bucket, status);

CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_family
  ON strategy_spec_registry(family_id, status);

CREATE TABLE IF NOT EXISTS strategy_decision_log (
  decision_id              TEXT PRIMARY KEY,
  date                     TEXT NOT NULL,
  symbol                   TEXT NOT NULL,
  name                     TEXT,
  strategy_id              TEXT NOT NULL,
  strategy_version         TEXT NOT NULL,
  strategy_status          TEXT NOT NULL,
  alpha_bucket             TEXT NOT NULL,
  matched                  INTEGER NOT NULL DEFAULT 0,
  match_score              REAL,
  reason_code              TEXT NOT NULL,
  context_json             TEXT NOT NULL DEFAULT '{}',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(date, symbol, strategy_id, strategy_version)
);

CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_date
  ON strategy_decision_log(date DESC, strategy_id, matched);

CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_symbol
  ON strategy_decision_log(symbol, date DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_status
  ON strategy_decision_log(strategy_status, matched, date DESC);

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
  reference_source TEXT NOT NULL DEFAULT 'native' CHECK(reference_source IN ('native', 'historical_reconstruction')),
  strategy_matrix_status TEXT NOT NULL DEFAULT 'ready' CHECK(strategy_matrix_status IN ('ready', 'unavailable')),
  reconstruction_reason TEXT,
  source_artifact_checksum TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, symbol, producer_run_id)
);

CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_date
  ON selection_reference_snapshots_v1(signal_date, hard_gate_passed, strategy_selected);

CREATE INDEX IF NOT EXISTS idx_selection_reference_v1_symbol
  ON selection_reference_snapshots_v1(symbol, signal_date DESC);

CREATE TABLE IF NOT EXISTS selection_reference_repair_runs_v1 (
  signal_date TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('writing', 'ready', 'failed')),
  expected_rows INTEGER NOT NULL,
  persisted_rows INTEGER NOT NULL DEFAULT 0,
  source_artifact_id TEXT NOT NULL,
  source_artifact_checksum TEXT NOT NULL,
  source_artifact_schema TEXT NOT NULL,
  strategy_matrix_status TEXT NOT NULL CHECK(strategy_matrix_status IN ('ready', 'unavailable')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(signal_date, producer_run_id)
);

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

CREATE TABLE IF NOT EXISTS strategy_reward_ledger (
  reward_id                TEXT PRIMARY KEY,
  strategy_id              TEXT NOT NULL,
  strategy_version         TEXT NOT NULL,
  strategy_status          TEXT NOT NULL,
  alpha_bucket             TEXT NOT NULL,
  date_start               TEXT,
  date_end                 TEXT,
  horizon_days             INTEGER NOT NULL DEFAULT 5,
  samples                  INTEGER NOT NULL DEFAULT 0,
  hit_rate                 REAL,
  avg_return_pct           REAL,
  reward_sum               REAL,
  max_drawdown_pct         REAL,
  coverage                 REAL,
  market_segment           TEXT DEFAULT 'all',
  regime                   TEXT DEFAULT 'all',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  refresh_run_id           TEXT,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(strategy_id, strategy_version, horizon_days, market_segment, regime)
);

CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_strategy
  ON strategy_reward_ledger(strategy_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_status
  ON strategy_reward_ledger(strategy_status, samples DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_refresh
  ON strategy_reward_ledger(refresh_run_id, date_end);

CREATE TABLE IF NOT EXISTS strategy_policy_state (
  policy_id                TEXT PRIMARY KEY,
  version                  TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('shadow','candidate','active','retired')),
  strategy_weights_json    TEXT NOT NULL DEFAULT '{}',
  threshold_deltas_json    TEXT NOT NULL DEFAULT '{}',
  evidence_json            TEXT NOT NULL DEFAULT '{}',
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parameter_candidate_registry (
  candidate_id          TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  config_hash           TEXT,
  sandbox_id            TEXT,
  cadence               TEXT,
  run_id                TEXT,
  status                TEXT NOT NULL CHECK(status IN (
    'NO_CANDIDATE',
    'SHADOW_COLLECTING',
    'VALIDATION_BLOCKED',
    'EVIDENCE_INSUFFICIENT',
    'NOT_PROMOTION_READY',
    'INFRA_BLOCKED',
    'PROMOTION_READY',
    'APPROVAL_REQUIRED',
    'PROD_ACTIVE'
  )),
  metadata_json         TEXT,
  latest_evidence_json  TEXT,
  promotion_packet_id   TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_parameter_candidate_registry_status
  ON parameter_candidate_registry(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_parameter_candidate_registry_packet
  ON parameter_candidate_registry(promotion_packet_id);

CREATE TABLE IF NOT EXISTS parameter_candidate_evidence (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id          TEXT NOT NULL,
  evidence_type         TEXT NOT NULL,
  decision              TEXT NOT NULL CHECK(decision IN ('PASS','FAIL')),
  evidence_json         TEXT,
  promotion_packet_id   TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_parameter_candidate_evidence_candidate
  ON parameter_candidate_evidence(candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS parameter_candidate_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id          TEXT,
  event_type            TEXT NOT NULL,
  detail_json           TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_parameter_candidate_events_candidate
  ON parameter_candidate_events(candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS entry_model_replay_reports (
  report_id                TEXT PRIMARY KEY,
  version                  TEXT NOT NULL,
  start_date               TEXT NOT NULL,
  end_date                 TEXT NOT NULL,
  loaded_cases             INTEGER NOT NULL DEFAULT 0,
  decision                 TEXT NOT NULL,
  passed                   INTEGER NOT NULL DEFAULT 0,
  failed_gates_json        TEXT NOT NULL DEFAULT '[]',
  summary_json             TEXT NOT NULL DEFAULT '{}',
  promotion_gate_json      TEXT NOT NULL DEFAULT '{}',
  report_json              TEXT NOT NULL DEFAULT '{}',
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entry_model_replay_reports_date
  ON entry_model_replay_reports(start_date DESC, end_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_model_replay_reports_gate
  ON entry_model_replay_reports(passed, decision, created_at DESC);

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

CREATE TABLE IF NOT EXISTS strategy_marginal_edge_runs_v4 (
  run_id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('shadow','promoted','failed')),
  strategy_count INTEGER NOT NULL,
  eligible_strategy_count INTEGER NOT NULL,
  sample_dates INTEGER NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_strategy_marginal_edge_runs_v4_date
  ON strategy_marginal_edge_runs_v4(as_of_date DESC, status, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_marginal_edge_v4 (
  run_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  edge_schema_version TEXT NOT NULL DEFAULT 'strategy-marginal-edge-v4',
  observation_dates INTEGER NOT NULL,
  candidate_observations INTEGER NOT NULL,
  marginal_edge_mean REAL,
  marginal_edge_lcb90 REAL,
  positive_date_rate REAL,
  absolute_hit_return_mean REAL,
  production_eligible INTEGER NOT NULL DEFAULT 0 CHECK(production_eligible IN (0,1)),
  production_weight_raw REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, strategy_id, strategy_version),
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_marginal_edge_v4_latest
  ON strategy_marginal_edge_v4(as_of_date DESC, production_eligible, strategy_id);

CREATE TABLE IF NOT EXISTS strategy_marginal_edge_dates_v4 (
  run_id TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  candidate_residual_return REAL,
  candidate_absolute_return REAL,
  champion_residual_return REAL,
  champion_absolute_return REAL,
  paired_residual_delta REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, signal_date),
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_marginal_edge_dates_v4_date
  ON strategy_marginal_edge_dates_v4(signal_date, run_id);

CREATE TABLE IF NOT EXISTS strategy_marginal_edge_head_v4 (
  owner_key TEXT PRIMARY KEY CHECK(owner_key = 'production'),
  run_id TEXT NOT NULL,
  previous_run_id TEXT,
  promoted_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES strategy_marginal_edge_runs_v4(run_id)
);

CREATE INDEX IF NOT EXISTS idx_s12_tw_calibration_entry_cohort
  ON s12_tw_calibration_artifacts(
    status, superseded_at, entry_cohort, market_segment, alpha_bucket, entry_time_bucket, approved_at DESC
  );

CREATE TABLE IF NOT EXISTS price_horizon_labels_v1 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
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
  PRIMARY KEY(stock_id, price_date),
  CHECK(entry_date > price_date),
  CHECK(exit_date >= entry_date),
  CHECK(outcome_known_date = exit_date),
  CHECK(entry_raw_open > 0),
  CHECK(exit_raw_close > 0),
  CHECK(entry_adjustment_factor > 0),
  CHECK(exit_adjustment_factor > 0)
);

CREATE INDEX IF NOT EXISTS idx_price_horizon_labels_date ON price_horizon_labels_v1(price_date, stock_id);

CREATE INDEX IF NOT EXISTS idx_price_horizon_labels_outcome ON price_horizon_labels_v1(outcome_known_date, price_date);

CREATE TABLE IF NOT EXISTS price_horizon_label_rejections_v1 (
  stock_id INTEGER NOT NULL,
  price_date TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  rejection_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  projection_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(stock_id, price_date)
);

CREATE INDEX IF NOT EXISTS idx_price_horizon_rejections_date
  ON price_horizon_label_rejections_v1(price_date, rejection_reason);
