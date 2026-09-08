-- Explicit operator dispositions only. A missing source is never a successful evidence day.
CREATE TABLE IF NOT EXISTS strategy_evidence_gap_dispositions_v1 (
  signal_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('excluded_missing_source','revoked')),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  approval_ref TEXT NOT NULL CHECK(length(trim(approval_ref))>0),
  evidence_ref TEXT NOT NULL CHECK(length(trim(evidence_ref))>0),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

