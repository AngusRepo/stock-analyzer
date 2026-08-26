CREATE TABLE IF NOT EXISTS active8_ensemble_artifacts_v1 (
  artifact_id TEXT PRIMARY KEY CHECK(length(trim(artifact_id)) > 0),
  cohort_id TEXT NOT NULL UNIQUE CHECK(length(trim(cohort_id)) > 0),
  training_run_id TEXT NOT NULL CHECK(length(trim(training_run_id)) > 0),
  knowledge_cutoff_date TEXT NOT NULL CHECK(length(knowledge_cutoff_date) = 10),
  schema_version TEXT NOT NULL CHECK(schema_version = 'active8-oof-ensemble-serving-artifact-v1'),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_checksum TEXT NOT NULL UNIQUE CHECK(length(payload_checksum) = 64),
  base_artifact_set_checksum TEXT NOT NULL CHECK(length(base_artifact_set_checksum) = 64),
  validation_decision TEXT NOT NULL CHECK(validation_decision IN ('PASS','FAIL')),
  validation_json TEXT NOT NULL CHECK(json_valid(validation_json)),
  archive_uri TEXT NOT NULL CHECK(length(trim(archive_uri)) > 0),
  state TEXT NOT NULL CHECK(state IN ('candidate','production','rejected','archived')),
  production_effect INTEGER NOT NULL DEFAULT 0 CHECK(production_effect IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((state = 'production' AND production_effect = 1) OR (state != 'production' AND production_effect = 0))
);

CREATE INDEX IF NOT EXISTS idx_active8_ensemble_artifacts_state
  ON active8_ensemble_artifacts_v1(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_active8_ensemble_artifacts_run
  ON active8_ensemble_artifacts_v1(training_run_id, knowledge_cutoff_date DESC);

CREATE TABLE IF NOT EXISTS active8_ensemble_pointer_v1 (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  artifact_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum) = 64),
  base_artifact_set_checksum TEXT NOT NULL CHECK(length(base_artifact_set_checksum) = 64),
  promoted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promotion_reason TEXT NOT NULL,
  promotion_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(promotion_evidence_json)),
  FOREIGN KEY(artifact_id) REFERENCES active8_ensemble_artifacts_v1(artifact_id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO data_domain_control_revisions(table_name, revision, updated_at)
VALUES
  ('active8_ensemble_artifacts_v1', 0, CURRENT_TIMESTAMP),
  ('active8_ensemble_pointer_v1', 0, CURRENT_TIMESTAMP);

CREATE TRIGGER IF NOT EXISTS trg_active8_ensemble_artifacts_revision_insert
AFTER INSERT ON active8_ensemble_artifacts_v1 BEGIN
  UPDATE data_domain_control_revisions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE table_name='active8_ensemble_artifacts_v1';
END;
CREATE TRIGGER IF NOT EXISTS trg_active8_ensemble_artifacts_revision_update
AFTER UPDATE ON active8_ensemble_artifacts_v1 BEGIN
  UPDATE data_domain_control_revisions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE table_name='active8_ensemble_artifacts_v1';
END;
CREATE TRIGGER IF NOT EXISTS trg_active8_ensemble_pointer_revision
AFTER INSERT ON active8_ensemble_pointer_v1 BEGIN
  UPDATE data_domain_control_revisions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE table_name='active8_ensemble_pointer_v1';
END;
CREATE TRIGGER IF NOT EXISTS trg_active8_ensemble_pointer_revision_update
AFTER UPDATE ON active8_ensemble_pointer_v1 BEGIN
  UPDATE data_domain_control_revisions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE table_name='active8_ensemble_pointer_v1';
END;
CREATE TRIGGER IF NOT EXISTS trg_active8_ensemble_pointer_revision_delete
AFTER DELETE ON active8_ensemble_pointer_v1 BEGIN
  UPDATE data_domain_control_revisions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE table_name='active8_ensemble_pointer_v1';
END;
