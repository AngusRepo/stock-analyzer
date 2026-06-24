-- Expand model_artifact_registry.candidate_type CHECK constraint.
-- D1/SQLite cannot ALTER a CHECK constraint in place, so rebuild the table
-- and preserve all existing rows.

PRAGMA foreign_keys=off;

CREATE TABLE model_artifact_registry_new (
  artifact_id                 TEXT PRIMARY KEY,
  model_name                  TEXT NOT NULL,
  version                     TEXT NOT NULL,
  candidate_type              TEXT NOT NULL CHECK(candidate_type IN ('monthly_release','weekly_drift','manual_hotfix','model_family_shadow','research_benchmark','timesfm_l175_l2_feature_release','unknown')),
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

INSERT INTO model_artifact_registry_new (
  artifact_id,
  model_name,
  version,
  candidate_type,
  state,
  artifact_path,
  metadata_path,
  training_run_id,
  training_manifest_path,
  trained_from_snapshot,
  evaluation_baseline_version,
  final_compared_to,
  feature_policy_version,
  checksum,
  source_run_date,
  is_monthly,
  offline_gate_status,
  offline_gate_decision,
  offline_gate_failed_gates,
  offline_evidence_json,
  live_gate_status,
  live_evidence_json,
  promotion_decision,
  approval_state,
  created_at,
  updated_at
)
SELECT
  artifact_id,
  model_name,
  version,
  candidate_type,
  state,
  artifact_path,
  metadata_path,
  training_run_id,
  training_manifest_path,
  trained_from_snapshot,
  evaluation_baseline_version,
  final_compared_to,
  feature_policy_version,
  checksum,
  source_run_date,
  is_monthly,
  offline_gate_status,
  offline_gate_decision,
  offline_gate_failed_gates,
  offline_evidence_json,
  live_gate_status,
  live_evidence_json,
  promotion_decision,
  approval_state,
  created_at,
  updated_at
FROM model_artifact_registry;

DROP TABLE model_artifact_registry;
ALTER TABLE model_artifact_registry_new RENAME TO model_artifact_registry;

CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_model_state
  ON model_artifact_registry(model_name, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_candidate_type
  ON model_artifact_registry(candidate_type, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_artifact_registry_run
  ON model_artifact_registry(training_run_id, source_run_date);

PRAGMA foreign_keys=on;
