-- Ops todo kanban: one row per backlog card (ids reuse the existing tracker ids, e.g. K15,
-- FG-02). A card in lane 'ready' (done, awaiting release) must carry a planned release date and
-- at least one PR; the table CHECK enforces it on every write path, not only the Worker route.
CREATE TABLE IF NOT EXISTS todo_cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('todo','doing','ready','live')),
  position REAL NOT NULL DEFAULT 0,
  section TEXT,
  owner TEXT,
  deadline TEXT,
  release_date TEXT,
  prs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(prs_json) AND json_type(prs_json)='array'),
  content TEXT,
  depends_on TEXT,
  source TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  CHECK(lane <> 'ready' OR (release_date IS NOT NULL AND trim(release_date) <> '' AND json_array_length(prs_json) > 0))
);
CREATE TABLE IF NOT EXISTS todo_card_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_lane TEXT,
  to_lane TEXT,
  actor TEXT,
  detail_json TEXT,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_todo_card_events_card_at
  ON todo_card_events(card_id,at);
