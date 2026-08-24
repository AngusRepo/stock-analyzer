-- Append-only, versioned L1.5 route evidence. Historical PIT replay is
-- materialized here without mutating immutable v1/v2 selection references.
CREATE TABLE IF NOT EXISTS strategy_route_versioned_evidence_v1 (
  route_version TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  producer_run_id TEXT NOT NULL,
  route_score REAL NOT NULL CHECK(route_score >= 0 AND route_score <= 100),
  incumbent_route_version TEXT NOT NULL,
  incumbent_route_score REAL,
  strategy_spec_version TEXT NOT NULL,
  evidence_method TEXT NOT NULL CHECK(evidence_method IN (
    'deterministic_paired_pit_replay',
    'production_forward'
  )),
  source_reference_contract TEXT NOT NULL,
  evidence_artifact_id TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  row_checksum TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect = 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(route_version, signal_date, symbol, producer_run_id)
);

CREATE INDEX IF NOT EXISTS idx_strategy_route_versioned_evidence_v1_date
  ON strategy_route_versioned_evidence_v1(route_version, signal_date, producer_run_id);

CREATE INDEX IF NOT EXISTS idx_strategy_route_versioned_evidence_v1_artifact
  ON strategy_route_versioned_evidence_v1(evidence_artifact_id, artifact_checksum);
