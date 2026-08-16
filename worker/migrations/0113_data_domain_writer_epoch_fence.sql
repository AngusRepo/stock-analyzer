-- Shared writer epoch authority. Protected post-migration installers create
-- per-table triggers as single D1 statements; missing triggers keep cutover
-- fail-closed.
CREATE TABLE IF NOT EXISTS data_domain_writer_epochs (
  domain TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  writer_state TEXT NOT NULL DEFAULT 'open' CHECK(writer_state IN ('open', 'quiescing', 'cutover')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS data_domain_table_writer_epochs (
  domain TEXT NOT NULL,
  table_name TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(domain, table_name)
);

INSERT INTO data_domain_writer_epochs(domain, epoch, writer_state)
VALUES ('ops', 0, 'open')
ON CONFLICT(domain) DO NOTHING;
