-- Immutable activation of one never-started native successor. No historical NAV transfer.
CREATE TABLE IF NOT EXISTS paired_native_prestart_successions_v1 (
 old_snapshot_id TEXT PRIMARY KEY,
 new_snapshot_id TEXT NOT NULL UNIQUE,
 old_pair_id TEXT NOT NULL UNIQUE,
 new_pair_id TEXT NOT NULL UNIQUE,
 payload_json TEXT NOT NULL,
 payload_checksum TEXT NOT NULL,
 recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS paired_native_prestart_no_update_v1 BEFORE UPDATE ON paired_native_prestart_successions_v1 BEGIN SELECT RAISE(ABORT,'paired_native_immutable_prestart'); END;
CREATE TRIGGER IF NOT EXISTS paired_native_prestart_no_delete_v1 BEFORE DELETE ON paired_native_prestart_successions_v1 BEGIN SELECT RAISE(ABORT,'paired_native_immutable_prestart'); END;
CREATE TRIGGER IF NOT EXISTS paired_native_prestart_no_replace_v1 BEFORE INSERT ON paired_native_prestart_successions_v1 WHEN EXISTS(SELECT 1 FROM paired_native_prestart_successions_v1 WHERE old_snapshot_id=NEW.old_snapshot_id OR new_snapshot_id=NEW.new_snapshot_id OR old_pair_id=NEW.old_pair_id OR new_pair_id=NEW.new_pair_id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM paired_native_prestart_successions_v1 WHERE old_snapshot_id=NEW.old_snapshot_id AND new_snapshot_id=NEW.new_snapshot_id AND old_pair_id=NEW.old_pair_id AND new_pair_id=NEW.new_pair_id AND payload_json=NEW.payload_json AND payload_checksum=NEW.payload_checksum) THEN RAISE(IGNORE) ELSE RAISE(ABORT,'paired_native_immutable_prestart') END;
END;
