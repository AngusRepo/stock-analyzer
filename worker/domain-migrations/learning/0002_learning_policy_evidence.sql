-- Incremental learning-domain schema for policy, Meta and frozen-forward evidence.
CREATE TABLE IF NOT EXISTS strategy_production_policy_history_v1 (
  policy_id TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active')),
  strategy_weights_json TEXT NOT NULL,
  quarantined_strategy_ids_json TEXT NOT NULL DEFAULT '[]',
  candidate_ready_strategy_ids_json TEXT NOT NULL DEFAULT '[]',
  base_weight_source TEXT NOT NULL,
  base_weight_run_id TEXT,
  evidence_json TEXT NOT NULL,
  canonical_payload TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(policy_id, knowledge_cutoff_date, checksum)
);

CREATE INDEX IF NOT EXISTS idx_strategy_production_policy_history_v1_cutoff
  ON strategy_production_policy_history_v1(policy_id, status, knowledge_cutoff_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS expected_return_shadow_evaluation_packets (
  evaluation_id TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  base_manifest_checksum TEXT NOT NULL CHECK(length(base_manifest_checksum) = 64),
  extension_manifest_checksum TEXT NOT NULL CHECK(length(extension_manifest_checksum) = 64),
  model_name TEXT NOT NULL CHECK(model_name IN ('l4_alpha_ev','allocator_ev_fusion')),
  model_version TEXT NOT NULL,
  oof_min_date TEXT NOT NULL,
  oof_max_date TEXT NOT NULL,
  oof_date_count INTEGER NOT NULL CHECK(oof_date_count > 0),
  oof_row_count INTEGER NOT NULL CHECK(oof_row_count > 0),
  quality_decision TEXT NOT NULL,
  policy_decision TEXT NOT NULL CHECK(policy_decision = 'shadow_only'),
  validation_packet_json TEXT NOT NULL CHECK(json_valid(validation_packet_json)),
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL CHECK(length(artifact_checksum) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_name, cohort_id, extension_manifest_checksum)
);

CREATE INDEX IF NOT EXISTS idx_expected_return_shadow_eval_owner_date
  ON expected_return_shadow_evaluation_packets(model_name, business_date DESC, oof_max_date DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_expected_return_shadow_eval_cohort
  ON expected_return_shadow_evaluation_packets(cohort_id, extension_manifest_checksum, model_name);

CREATE TABLE IF NOT EXISTS adaptive_meta_policy_decisions (
  decision_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  candidate_policy_id TEXT,
  method TEXT,
  decision TEXT NOT NULL CHECK(decision IN (
    'reject','observe','promote_canary','promote_active','retain_canary','retain_active','rollback'
  )),
  reason TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('inactive','observing','canary','active','rolled_back')),
  consecutive_passes INTEGER NOT NULL DEFAULT 0,
  previous_policy_id TEXT,
  serving_policy_id TEXT,
  apply_status TEXT NOT NULL CHECK(apply_status IN ('pending_apply','applied','failed')),
  apply_error TEXT,
  failed_checks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(failed_checks_json)),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_adaptive_meta_policy_decisions_run
  ON adaptive_meta_policy_decisions(run_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adaptive_meta_policy_decisions_status
  ON adaptive_meta_policy_decisions(apply_status, phase, run_date DESC);

CREATE TABLE IF NOT EXISTS active8_oof_freshness_sla (
  decision_key TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  run_id TEXT,
  attempt_id TEXT,
  run_date TEXT,
  cadence TEXT,
  status TEXT NOT NULL CHECK(status IN ('fresh', 'failed', 'missing')),
  reason TEXT NOT NULL,
  expected_max_date TEXT,
  effective_max_date TEXT,
  cohort_id TEXT,
  prep_manifest_checksum TEXT,
  callback_status TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_active8_oof_freshness_sla_status_date
  ON active8_oof_freshness_sla(status, run_date, observed_at);
CREATE INDEX IF NOT EXISTS idx_active8_oof_freshness_sla_task_date
  ON active8_oof_freshness_sla(task, run_date, observed_at);

CREATE TABLE IF NOT EXISTS strategy_adaptive_policy_history_v2 (
  policy_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('shadow','candidate','active','retired')),
  knowledge_cutoff_date TEXT NOT NULL,
  strategy_weights_json TEXT NOT NULL DEFAULT '{}',
  threshold_deltas_json TEXT NOT NULL DEFAULT '{}',
  lifecycle_recommendations_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (policy_id, knowledge_cutoff_date, state_hash)
);

CREATE INDEX IF NOT EXISTS idx_strategy_adaptive_policy_history_v2_pit
  ON strategy_adaptive_policy_history_v2(policy_id, status, knowledge_cutoff_date DESC, created_at DESC);
