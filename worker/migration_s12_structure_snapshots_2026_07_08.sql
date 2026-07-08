CREATE TABLE IF NOT EXISTS s12_structure_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date            TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 's12_intraday_structure_v1',
  side                  TEXT,
  state                 TEXT,
  ready                 INTEGER NOT NULL DEFAULT 0,
  invalidated           INTEGER NOT NULL DEFAULT 0,
  setup_id              TEXT,
  entry_price           REAL,
  chase_ceiling         REAL,
  structure_stop        REAL,
  target1_price         REAL,
  target2_price         REAL,
  target3_price         REAL,
  target4_price         REAL,
  demand_zone_low       REAL,
  demand_zone_high      REAL,
  supply_zone_low       REAL,
  supply_zone_high      REAL,
  detail                TEXT,
  entry_context_json    TEXT,
  exit_plan_json        TEXT,
  raw_json              TEXT,
  pending_run_id        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trade_date, symbol, source)
);

CREATE INDEX IF NOT EXISTS idx_s12_structure_snapshots_date_symbol
  ON s12_structure_snapshots(trade_date DESC, symbol);

