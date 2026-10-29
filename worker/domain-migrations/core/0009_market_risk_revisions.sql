-- Append-only market_risk recomputations (PIT, Wei 10/29). Once the next session has opened,
-- a recomputation of a past date is recorded here and the original canonical row is kept.
CREATE TABLE IF NOT EXISTS market_risk_revisions_v1 (
 date TEXT NOT NULL, revision_checksum TEXT NOT NULL CHECK(length(revision_checksum)=64),
 risk_json TEXT NOT NULL, quality_json TEXT NOT NULL,
 canonical_mode TEXT NOT NULL CHECK(canonical_mode IN ('replace','keep_original')),
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(date,revision_checksum)
);
