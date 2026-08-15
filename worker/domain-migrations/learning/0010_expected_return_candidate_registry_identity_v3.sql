-- Content-addressed expected-return candidate identity.
-- Preserve every cohort/checksum successor instead of overwriting one
-- (model_name, version, candidate_type) row.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE IF NOT EXISTS data_domain_control_revisions (
  table_name TEXT PRIMARY KEY CHECK(table_name IN (
    'model_artifact_registry',
    'expected_return_artifact_payloads',
    'model_champion_history',
    'model_champion_pointers'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO data_domain_control_revisions(table_name, revision)
VALUES
  ('model_artifact_registry', 0),
  ('expected_return_artifact_payloads', 0),
  ('model_champion_history', 0),
  ('model_champion_pointers', 0)
ON CONFLICT(table_name) DO NOTHING;

DROP TRIGGER IF EXISTS trg_model_artifact_registry_revision_insert;
DROP TRIGGER IF EXISTS trg_model_artifact_registry_revision_update;
DROP TRIGGER IF EXISTS trg_model_artifact_registry_revision_delete;
DROP TRIGGER IF EXISTS trg_expected_return_artifact_payloads_revision_insert;
DROP TRIGGER IF EXISTS trg_expected_return_artifact_payloads_revision_update;
DROP TRIGGER IF EXISTS trg_expected_return_artifact_payloads_revision_delete;
DROP INDEX IF EXISTS idx_model_artifact_registry_model_state;
DROP INDEX IF EXISTS idx_model_artifact_registry_candidate_type;
DROP INDEX IF EXISTS idx_model_artifact_registry_run;
DROP INDEX IF EXISTS idx_expected_return_artifact_payloads_owner;

ALTER TABLE expected_return_artifact_payloads
  RENAME TO expected_return_artifact_payloads_identity_v2_legacy;
ALTER TABLE model_artifact_registry
  RENAME TO model_artifact_registry_identity_v2_legacy;

CREATE TABLE model_artifact_registry (
  artifact_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(artifact_id)) > 0),
  model_name TEXT NOT NULL,
  version TEXT NOT NULL,
  candidate_type TEXT NOT NULL CHECK(candidate_type IN (
    'monthly_release','weekly_drift','oof_full_fit_release','manual_hotfix',
    'model_family_shadow','research_benchmark',
    'timesfm_l175_l2_feature_release','l4_alpha_ev_refresh',
    'allocator_ev_fusion_refresh','unknown'
  )),
  state TEXT NOT NULL CHECK(state IN (
    'registered','registration_failed','offline_failed','offline_passed_weak',
    'offline_passed','offline_strong_pass','candidate_selected','shadowing',
    'live_gate_passed','approval_required','approved','production','rejected',
    'archived'
  )),
  artifact_path TEXT,
  metadata_path TEXT,
  training_run_id TEXT,
  training_manifest_path TEXT,
  trained_from_snapshot TEXT,
  evaluation_baseline_version TEXT,
  final_compared_to TEXT,
  feature_policy_version TEXT,
  checksum TEXT,
  source_run_date TEXT,
  is_monthly INTEGER NOT NULL DEFAULT 0,
  offline_gate_status TEXT NOT NULL DEFAULT 'not_evaluated',
  offline_gate_decision TEXT NOT NULL DEFAULT 'PENDING',
  offline_gate_failed_gates TEXT NOT NULL DEFAULT '[]',
  offline_evidence_json TEXT NOT NULL DEFAULT '{}',
  live_gate_status TEXT NOT NULL DEFAULT 'not_started',
  live_evidence_json TEXT NOT NULL DEFAULT '{}',
  promotion_decision TEXT NOT NULL DEFAULT 'not_evaluated',
  approval_state TEXT NOT NULL DEFAULT 'not_required',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO model_artifact_registry (
  artifact_id, model_name, version, candidate_type, state, artifact_path,
  metadata_path, training_run_id, training_manifest_path, trained_from_snapshot,
  evaluation_baseline_version, final_compared_to, feature_policy_version,
  checksum, source_run_date, is_monthly, offline_gate_status,
  offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
  live_gate_status, live_evidence_json, promotion_decision, approval_state,
  created_at, updated_at
)
SELECT
  artifact_id, model_name, version, candidate_type, state, artifact_path,
  metadata_path, training_run_id, training_manifest_path, trained_from_snapshot,
  evaluation_baseline_version, final_compared_to, feature_policy_version,
  checksum, source_run_date, is_monthly, offline_gate_status,
  offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
  live_gate_status, live_evidence_json, promotion_decision, approval_state,
  created_at, updated_at
FROM model_artifact_registry_identity_v2_legacy;

CREATE INDEX idx_model_artifact_registry_model_state
  ON model_artifact_registry(model_name, state, updated_at DESC);
CREATE INDEX idx_model_artifact_registry_candidate_type
  ON model_artifact_registry(candidate_type, state, updated_at DESC);
CREATE INDEX idx_model_artifact_registry_run
  ON model_artifact_registry(training_run_id, source_run_date);
CREATE INDEX idx_model_artifact_registry_identity_v3
  ON model_artifact_registry(model_name, version, candidate_type, updated_at DESC);

CREATE TABLE expected_return_artifact_payloads (
  artifact_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(artifact_id)) > 0),
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
  FOREIGN KEY(artifact_id) REFERENCES model_artifact_registry(artifact_id) ON DELETE RESTRICT
);

INSERT INTO expected_return_artifact_payloads (
  artifact_id, model_name, model_version, serving_mode, artifact_json,
  payload_checksum, source_artifact_path, source_artifact_checksum,
  source_cohort_id, created_at, updated_at
)
SELECT
  artifact_id, model_name, model_version, serving_mode, artifact_json,
  payload_checksum, source_artifact_path, source_artifact_checksum,
  source_cohort_id, created_at, updated_at
FROM expected_return_artifact_payloads_identity_v2_legacy;

CREATE INDEX idx_expected_return_artifact_payloads_owner
  ON expected_return_artifact_payloads(model_name, serving_mode, updated_at DESC);
CREATE INDEX idx_expected_return_artifact_payloads_version
  ON expected_return_artifact_payloads(model_name, model_version, updated_at DESC);

DROP TABLE expected_return_artifact_payloads_identity_v2_legacy;
DROP TABLE model_artifact_registry_identity_v2_legacy;

UPDATE data_domain_control_revisions
   SET revision=revision + 1, updated_at=CURRENT_TIMESTAMP
 WHERE table_name IN ('model_artifact_registry','expected_return_artifact_payloads');

-- The table rebuild drops registry/payload triggers. Reinstall all twelve only
-- after both D1 lanes finish migrating via the protected Worker binding task;
-- missing triggers leave strict cutover fail-closed.

PRAGMA defer_foreign_keys=OFF;
