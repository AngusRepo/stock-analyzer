-- Expand the formal Ops artifact manifest contract for checksum-verified
-- ten-year cold archives. Rebuild is required because SQLite cannot alter a
-- CHECK constraint in place.
CREATE TABLE run_artifacts_retention_v2 (
  artifact_id TEXT PRIMARY KEY,
  retention_class TEXT NOT NULL CHECK(retention_class IN (
    'canonical_execution','canonical_model_evidence','paper_shadow',
    'superseded_run','failed_debug','request_debug','raw_market_unreferenced',
    'staging_orphan','ten_year_cold_archive','incident_pinned'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'writing','validating','ready','integrity_blocked','payload_deleted'
  )),
  domain TEXT NOT NULL,
  business_date TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  canonical_run_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  retain_until TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
  hard_ref_count INTEGER NOT NULL DEFAULT 0,
  checksum_verified_at TEXT,
  payload_deleted_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO run_artifacts_retention_v2 (
  artifact_id, retention_class, status, domain, business_date,
  producer_run_id, canonical_run_id, r2_key, checksum, schema_version,
  row_count, byte_size, created_at, retain_until, pinned, legal_hold,
  hard_ref_count, checksum_verified_at, payload_deleted_at, metadata_json, updated_at
)
SELECT
  artifact_id, retention_class, status, domain, business_date,
  producer_run_id, canonical_run_id, r2_key, checksum, schema_version,
  row_count, byte_size, created_at, retain_until, pinned, legal_hold,
  hard_ref_count, checksum_verified_at, payload_deleted_at, metadata_json, updated_at
FROM run_artifacts;

DROP TABLE run_artifacts;
ALTER TABLE run_artifacts_retention_v2 RENAME TO run_artifacts;

CREATE INDEX idx_run_artifacts_retention
  ON run_artifacts(status, retain_until, pinned, legal_hold, hard_ref_count);
CREATE INDEX idx_run_artifacts_producer
  ON run_artifacts(producer_run_id, domain, business_date);
