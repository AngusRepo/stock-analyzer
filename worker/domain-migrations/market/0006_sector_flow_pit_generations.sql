-- Append-only, complete multi-layer generations. Current sector_flow remains a UI projection.
CREATE TABLE IF NOT EXISTS sector_flow_pit_generations_v1 (
  generation_id TEXT PRIMARY KEY,
  signal_date TEXT NOT NULL,
  available_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum)=64),
  row_count INTEGER NOT NULL CHECK(row_count>0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sector_flow_pit_generation_cutoff
  ON sector_flow_pit_generations_v1(signal_date DESC, available_at DESC);
CREATE TRIGGER IF NOT EXISTS sector_flow_pit_generation_no_update
BEFORE UPDATE ON sector_flow_pit_generations_v1 BEGIN
  SELECT RAISE(ABORT, 'sector_flow_pit_generation_immutable');
END;
