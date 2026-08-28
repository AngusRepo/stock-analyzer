CREATE TABLE IF NOT EXISTS s12_exit_policy_artifacts_v1 (
  artifact_id TEXT PRIMARY KEY CHECK(length(trim(artifact_id)) > 0),
  schema_version TEXT NOT NULL CHECK(schema_version = 's12-profit-continuation-serving-artifact-v1'),
  contract_version TEXT NOT NULL CHECK(contract_version = 's12-profit-continuation-v1'),
  knowledge_cutoff_date TEXT NOT NULL CHECK(length(knowledge_cutoff_date) = 10),
  validation_start TEXT NOT NULL CHECK(length(validation_start) = 10),
  validation_end TEXT NOT NULL CHECK(length(validation_end) = 10),
  sample_count INTEGER NOT NULL CHECK(sample_count > 0),
  date_count INTEGER NOT NULL CHECK(date_count >= 2),
  scope TEXT NOT NULL CHECK(scope = 'paper_only'),
  real_order_effect INTEGER NOT NULL DEFAULT 0 CHECK(real_order_effect = 0),
  validation_decision TEXT NOT NULL CHECK(validation_decision = 'PASS'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_checksum TEXT NOT NULL UNIQUE CHECK(length(payload_checksum) = 64),
  source_receipt_checksum TEXT NOT NULL UNIQUE CHECK(length(source_receipt_checksum) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS s12_exit_policy_head_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  artifact_id TEXT NOT NULL,
  previous_artifact_id TEXT,
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promotion_reason TEXT NOT NULL,
  promotion_evidence_json TEXT NOT NULL CHECK(json_valid(promotion_evidence_json)),
  FOREIGN KEY(artifact_id) REFERENCES s12_exit_policy_artifacts_v1(artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY(previous_artifact_id) REFERENCES s12_exit_policy_artifacts_v1(artifact_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS s12_exit_policy_promotion_events_v1 (
  event_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  previous_artifact_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('promote','rollback')),
  actor TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(artifact_id) REFERENCES s12_exit_policy_artifacts_v1(artifact_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_s12_exit_policy_events_created
  ON s12_exit_policy_promotion_events_v1(created_at DESC, event_id DESC);
