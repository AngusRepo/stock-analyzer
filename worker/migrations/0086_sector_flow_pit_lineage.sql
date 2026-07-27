-- Immutable availability lineage for post-recommendation sector-flow evidence.
-- Existing rows remain ineligible until the producer rewrites them under v1.
ALTER TABLE sector_flow ADD COLUMN updated_at TEXT;
ALTER TABLE sector_flow ADD COLUMN pit_lineage_version TEXT;

CREATE INDEX IF NOT EXISTS idx_sector_flow_pit_lineage
  ON sector_flow(pit_lineage_version, date DESC, updated_at);
