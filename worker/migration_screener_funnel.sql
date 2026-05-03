-- Screener funnel observability.
-- Records each daily screener run and per-symbol pass/drop evidence so
-- dashboard/pipeline decisions can be audited without falling back to chat memory.

CREATE TABLE IF NOT EXISTS screener_funnel_runs (
  run_id          TEXT PRIMARY KEY,
  date            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'success',
  universe_count  INTEGER DEFAULT 0,
  candidate_count INTEGER DEFAULT 0,
  final_count     INTEGER DEFAULT 0,
  emerging_count  INTEGER DEFAULT 0,
  metadata        TEXT,
  debug_log       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_runs_date
  ON screener_funnel_runs(date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS screener_funnel_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  date          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  name          TEXT,
  stage         TEXT NOT NULL,
  decision      TEXT NOT NULL,
  reason_code   TEXT NOT NULL,
  score_before  REAL,
  score_after   REAL,
  rank          INTEGER,
  evidence      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(run_id) REFERENCES screener_funnel_runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_run
  ON screener_funnel_items(run_id, stage, decision);

CREATE INDEX IF NOT EXISTS idx_screener_funnel_items_symbol
  ON screener_funnel_items(symbol, date DESC);
