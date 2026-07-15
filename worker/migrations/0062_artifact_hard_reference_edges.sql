-- Reachability graph for R2 artifacts referenced by canonical heads or D1 pointers.

CREATE TABLE IF NOT EXISTS artifact_hard_references (
  reference_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_type, owner_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_hard_references_artifact_active
  ON artifact_hard_references(artifact_id, active);

CREATE INDEX IF NOT EXISTS idx_artifact_hard_references_owner_active
  ON artifact_hard_references(owner_type, owner_id, active);
