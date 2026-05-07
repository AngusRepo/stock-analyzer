CREATE TABLE IF NOT EXISTS dataset_snapshots (
  snapshot_id     TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  business_date   TEXT NOT NULL,
  market_segment  TEXT,
  schema_version  TEXT NOT NULL,
  row_count       INTEGER NOT NULL DEFAULT 0,
  checksum        TEXT NOT NULL,
  primary_store   TEXT NOT NULL CHECK(primary_store IN ('d1','gcs','r2')),
  access_tier     TEXT NOT NULL CHECK(access_tier IN ('serving','compute','report','preview','archive')),
  gcs_uri         TEXT,
  r2_key          TEXT,
  producer_run_id TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('pending','ready','failed','expired')),
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_kind_date
  ON dataset_snapshots(kind, business_date DESC, status);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_access_date
  ON dataset_snapshots(access_tier, business_date DESC, primary_store);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_run
  ON dataset_snapshots(producer_run_id, kind);
