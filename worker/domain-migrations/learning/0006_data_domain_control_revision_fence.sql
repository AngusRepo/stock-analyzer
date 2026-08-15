-- Monotonic mutation epochs for the four Learning control tables in Learning DB.
-- Keep this schema equivalent to legacy migration 0108; trigger bodies are
-- installed through the protected Worker binding task after schema migrations.
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

-- Wrangler remote migrations split CREATE TRIGGER BEGIN/END bodies and return
-- SQLITE_ERROR "incomplete input". The post-migration installer is idempotent;
-- missing triggers keep all strict cutover readiness gates fail-closed.
