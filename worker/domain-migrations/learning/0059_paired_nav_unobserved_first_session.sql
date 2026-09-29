-- An expired, never-observed native pair remains an auditable zero-NAV epoch.
CREATE TABLE IF NOT EXISTS paired_nav_unobserved_pairs_v1 (
  execution_snapshot_id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL UNIQUE,
  session_date TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_checksum TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS paired_nav_unobserved_no_update_v1
BEFORE UPDATE ON paired_nav_unobserved_pairs_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_unobserved'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_unobserved_no_delete_v1
BEFORE DELETE ON paired_nav_unobserved_pairs_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_unobserved'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_unobserved_no_replace_v1
BEFORE INSERT ON paired_nav_unobserved_pairs_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_unobserved_pairs_v1 WHERE execution_snapshot_id=NEW.execution_snapshot_id OR pair_id=NEW.pair_id)
BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM paired_nav_unobserved_pairs_v1 p
    WHERE p.execution_snapshot_id=NEW.execution_snapshot_id AND p.pair_id=NEW.pair_id
      AND p.session_date=NEW.session_date AND p.payload_json=NEW.payload_json
      AND p.payload_checksum=NEW.payload_checksum);
  SELECT RAISE(ABORT,'paired_nav_immutable_unobserved');
END;
