-- Keep OOF legality and retention decisions explicit. Old rows may be removed
-- from hot D1 only after immutable archive verification and reachability audit.

CREATE TABLE IF NOT EXISTS active8_oof_date_eligibility (
  cohort_id TEXT NOT NULL,
  prediction_date TEXT NOT NULL,
  evidence_scope TEXT NOT NULL CHECK(evidence_scope IN ('active8_oof','l4','fusion')),
  eligibility_status TEXT NOT NULL CHECK(eligibility_status IN ('legal', 'illegal', 'pending')),
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
  legality_state TEXT NOT NULL CHECK(legality_state IN ('legal', 'mixed', 'illegal', 'pending')),
  retention_action TEXT NOT NULL CHECK(retention_action IN ('retain_hot', 'archive_required', 'archive_only', 'delete_hot')),
  status TEXT NOT NULL CHECK(status IN ('planned', 'blocked', 'archived', 'verified', 'deleted', 'error')),
  d1_prediction_rows INTEGER NOT NULL DEFAULT 0,
  d1_snapshot_rows INTEGER NOT NULL DEFAULT 0,
  d1_l4_rows INTEGER NOT NULL DEFAULT 0,
  hard_reference_count INTEGER NOT NULL DEFAULT 0,
  archive_store TEXT CHECK(archive_store IN ('r2', 'gcs')),
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

INSERT OR IGNORE INTO data_retention_policies (
  policy_id, domain, dataset_pattern, hot_retention_days, cold_retention_days,
  archive_store, action, hard_reference_protected, version, status,
  approved_reason, created_at, updated_at
) VALUES (
  'oof_lineage_cold_archive_v2',
  'learning',
  'active8_oof_predictions,allocator_ev_oof_snapshots,l4_oof_predictions',
  730,
  3650,
  'gcs',
  'archive_delete',
  1,
  2,
  'active',
  'Illegal or superseded OOF full payload leaves hot D1 only after immutable checksum archive and zero active hard references; compact legality ledger remains hot.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
