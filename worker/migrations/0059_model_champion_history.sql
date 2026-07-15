-- Immutable point-in-time champion ledger used by L4/Fusion lineage reconstruction.
CREATE TABLE IF NOT EXISTS model_champion_history (
  event_id       TEXT PRIMARY KEY,
  model_name     TEXT NOT NULL,
  version        TEXT NOT NULL,
  artifact_id    TEXT,
  effective_at   TEXT NOT NULL,
  retired_at     TEXT,
  source         TEXT NOT NULL CHECK(source = 'model_champion_history'),
  evidence_grade TEXT NOT NULL CHECK(evidence_grade IN ('exact','bounded','unknown')),
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(model_name, version, effective_at)
);

CREATE INDEX IF NOT EXISTS idx_model_champion_history_asof
  ON model_champion_history(model_name, effective_at, retired_at);
