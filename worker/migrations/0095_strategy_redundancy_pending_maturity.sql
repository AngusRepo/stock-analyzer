-- Keep artifact lifecycle state explicit while preserving the existing compact ledger.
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_strategy_redundancy_artifacts_v1_date;

ALTER TABLE strategy_redundancy_artifacts_v1
  RENAME TO strategy_redundancy_artifacts_v1_legacy_0095;

CREATE TABLE strategy_redundancy_artifacts_v1 (
  artifact_id TEXT PRIMARY KEY,
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'pending_maturity', 'pass', 'fail')),
  source_contract TEXT NOT NULL,
  strategy_count INTEGER NOT NULL,
  paired_date_count INTEGER NOT NULL,
  oof_max_date TEXT,
  edge_count INTEGER NOT NULL,
  effective_strategy_count REAL,
  graph_json TEXT NOT NULL,
  evidence_artifact_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO strategy_redundancy_artifacts_v1 (
  artifact_id, as_of_date, status, source_contract, strategy_count,
  paired_date_count, oof_max_date, edge_count, effective_strategy_count,
  graph_json, evidence_artifact_id, created_at
)
SELECT
  artifact_id, as_of_date, status, source_contract, strategy_count,
  paired_date_count, oof_max_date, edge_count, effective_strategy_count,
  graph_json, evidence_artifact_id, created_at
FROM strategy_redundancy_artifacts_v1_legacy_0095;

DROP TABLE strategy_redundancy_artifacts_v1_legacy_0095;

CREATE INDEX idx_strategy_redundancy_artifacts_v1_date
  ON strategy_redundancy_artifacts_v1(as_of_date DESC, status, created_at DESC);

COMMIT;
