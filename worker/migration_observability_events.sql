-- P8: unified OBS event contract audit table
CREATE TABLE IF NOT EXISTS observability_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  date        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK(severity IN ('ok','info','warn','error')),
  domain      TEXT NOT NULL,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  owner       TEXT NOT NULL,
  impact      TEXT,
  next_action TEXT,
  evidence    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_observability_events_date ON observability_events(date, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_events_domain ON observability_events(domain, created_at DESC);
