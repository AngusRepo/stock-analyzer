CREATE TABLE IF NOT EXISTS data_domain_cutover_probe_canary (
  probe_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK(domain = 'execution'),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
