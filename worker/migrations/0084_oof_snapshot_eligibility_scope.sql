-- Split strict allocator snapshot eligibility from downstream L4/Fusion readiness.
-- SQLite CHECK constraints require a preserving table rebuild.

CREATE TABLE active8_oof_date_eligibility_v3 (
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

INSERT INTO active8_oof_date_eligibility_v3 (
  cohort_id, prediction_date, evidence_scope, eligibility_status,
  reason_code, evidence_schema_version, source_manifest_checksum,
  evidence_artifact_path, evidence_artifact_checksum,
  assessed_knowledge_cutoff, assessed_at
)
SELECT
  cohort_id, prediction_date, evidence_scope, eligibility_status,
  reason_code, evidence_schema_version, source_manifest_checksum,
  evidence_artifact_path, evidence_artifact_checksum,
  assessed_knowledge_cutoff, assessed_at
FROM active8_oof_date_eligibility;

DROP TABLE active8_oof_date_eligibility;
ALTER TABLE active8_oof_date_eligibility_v3 RENAME TO active8_oof_date_eligibility;

CREATE INDEX idx_active8_oof_date_eligibility_status
  ON active8_oof_date_eligibility(evidence_scope, eligibility_status, prediction_date, cohort_id);