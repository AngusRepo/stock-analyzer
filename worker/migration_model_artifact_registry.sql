CREATE TABLE IF NOT EXISTS model_artifact_registry (
  artifact_id                 TEXT PRIMARY KEY,
  model_name                  TEXT NOT NULL,
  version                     TEXT NOT NULL,
  candidate_type              TEXT NOT NULL CHECK(candidate_type IN ('monthly_release','weekly_drift','manual_hotfix','unknown')),
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
