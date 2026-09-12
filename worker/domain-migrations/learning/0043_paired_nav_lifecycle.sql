-- Immutable experiment transitions, not promotion authority or accounting gates.
CREATE TABLE IF NOT EXISTS paired_nav_lifecycle_closures_v1 (
  pair_id TEXT PRIMARY KEY,
  root_pair_id TEXT NOT NULL,
  successor_pair_id TEXT NOT NULL CHECK(successor_pair_id<>pair_id),
  successor_snapshot_id TEXT NOT NULL,
  transition_signal_date TEXT NOT NULL,
  final_session_date TEXT NOT NULL CHECK(final_session_date<=transition_signal_date),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_checksum TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paired_nav_lifecycle_root_v1
  ON paired_nav_lifecycle_closures_v1(root_pair_id,transition_signal_date);
CREATE INDEX IF NOT EXISTS paired_nav_lifecycle_successor_v1
  ON paired_nav_lifecycle_closures_v1(successor_snapshot_id);
CREATE TRIGGER IF NOT EXISTS paired_nav_lifecycle_no_update_v1
BEFORE UPDATE ON paired_nav_lifecycle_closures_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_lifecycle'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_lifecycle_no_delete_v1
BEFORE DELETE ON paired_nav_lifecycle_closures_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_lifecycle'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_lifecycle_no_replace_v1
BEFORE INSERT ON paired_nav_lifecycle_closures_v1
WHEN EXISTS (SELECT 1 FROM paired_nav_lifecycle_closures_v1 WHERE pair_id=NEW.pair_id)
BEGIN
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM paired_nav_lifecycle_closures_v1 p
    WHERE p.pair_id=NEW.pair_id AND p.root_pair_id=NEW.root_pair_id
      AND p.successor_pair_id=NEW.successor_pair_id
      AND p.successor_snapshot_id=NEW.successor_snapshot_id
      AND p.transition_signal_date=NEW.transition_signal_date
      AND p.final_session_date=NEW.final_session_date
      AND p.payload_json=NEW.payload_json AND p.payload_checksum=NEW.payload_checksum)
    ;
  SELECT RAISE(ABORT,'paired_nav_immutable_lifecycle');
END;
