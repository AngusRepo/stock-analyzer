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

-- CREATE TRIGGER bodies are installed after all schema migrations by the
-- protected data-domain-control-revision-trigger-install Worker task. Wrangler
-- remote migrations otherwise split BEGIN/END trigger bodies and fail with
-- SQLITE_ERROR "incomplete input". Missing triggers keep strict cutover blocked.
