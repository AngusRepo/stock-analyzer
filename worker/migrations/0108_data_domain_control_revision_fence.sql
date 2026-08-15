-- Monotonic mutation epochs for the four Learning control tables in legacy DB.
-- Rolling parity receipts bind these epochs so same-row-count UPDATEs cannot
-- remain hidden behind a completed keyset cursor.
CREATE TABLE IF NOT EXISTS data_domain_control_revisions (
  table_name TEXT PRIMARY KEY CHECK(table_name IN (
    'model_artifact_registry',
    'expected_return_artifact_payloads',
    'model_champion_history',
    'model_champion_pointers'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO data_domain_control_revisions(table_name, revision)
VALUES
  ('model_artifact_registry', 0),
  ('expected_return_artifact_payloads', 0),
  ('model_champion_history', 0),
  ('model_champion_pointers', 0)
ON CONFLICT(table_name) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS trg_model_artifact_registry_revision_insert
AFTER INSERT ON model_artifact_registry
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_artifact_registry', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_artifact_registry_revision_update
AFTER UPDATE ON model_artifact_registry
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_artifact_registry', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_artifact_registry_revision_delete
AFTER DELETE ON model_artifact_registry
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_artifact_registry', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_expected_return_artifact_payloads_revision_insert
AFTER INSERT ON expected_return_artifact_payloads
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('expected_return_artifact_payloads', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_expected_return_artifact_payloads_revision_update
AFTER UPDATE ON expected_return_artifact_payloads
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('expected_return_artifact_payloads', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_expected_return_artifact_payloads_revision_delete
AFTER DELETE ON expected_return_artifact_payloads
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('expected_return_artifact_payloads', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_champion_history_revision_insert
AFTER INSERT ON model_champion_history
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_champion_history', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_champion_history_revision_update
AFTER UPDATE ON model_champion_history
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_champion_history', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_champion_history_revision_delete
AFTER DELETE ON model_champion_history
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_champion_history', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_champion_pointers_revision_insert
AFTER INSERT ON model_champion_pointers
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_champion_pointers', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_champion_pointers_revision_update
AFTER UPDATE ON model_champion_pointers
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_champion_pointers', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;

CREATE TRIGGER IF NOT EXISTS trg_model_champion_pointers_revision_delete
AFTER DELETE ON model_champion_pointers
BEGIN
  INSERT INTO data_domain_control_revisions(table_name, revision, updated_at)
  VALUES ('model_champion_pointers', 1, CURRENT_TIMESTAMP)
  ON CONFLICT(table_name) DO UPDATE SET
    revision=revision + 1,
    updated_at=CURRENT_TIMESTAMP;
END;
