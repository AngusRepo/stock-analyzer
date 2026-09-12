-- Separate from EV prediction-date maturity. No serving pointer or order ownership.
-- Payloads are chunked to stay below D1's per-value limit. A published manifest
-- is valid only after every immutable part has been read back and hashed.
CREATE TABLE IF NOT EXISTS paired_nav_frozen_parts_v1 (
  snapshot_id TEXT NOT NULL, part_no INTEGER NOT NULL CHECK(part_no >= 0),
  payload_text TEXT NOT NULL, PRIMARY KEY(snapshot_id, part_no)
);
CREATE TABLE IF NOT EXISTS paired_nav_frozen_manifests_v1 (
  snapshot_id TEXT PRIMARY KEY, signal_date TEXT NOT NULL, source_run_id TEXT NOT NULL,
  frozen_at TEXT NOT NULL, payload_checksum TEXT NOT NULL,
  part_count INTEGER NOT NULL CHECK(part_count > 0),
  prospective INTEGER NOT NULL CHECK(prospective IN (0,1)),
  snapshot_kind TEXT NOT NULL CHECK(snapshot_kind IN ('allocation_context','allocation_pair','execution_pair','execution_receipt')),
  parent_snapshot_id TEXT,
  UNIQUE(signal_date, source_run_id, snapshot_kind)
);
CREATE TABLE IF NOT EXISTS paired_nav_daily_journal_v1 (
  pair_id TEXT NOT NULL, session_date TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, previous_checksum TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_checksum TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(pair_id, session_date), UNIQUE(pair_id, snapshot_id)
);
CREATE INDEX IF NOT EXISTS paired_nav_context_date_v1
  ON paired_nav_frozen_manifests_v1(signal_date, snapshot_kind);
CREATE TRIGGER IF NOT EXISTS paired_nav_parts_no_update_v1 BEFORE UPDATE ON paired_nav_frozen_parts_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_part'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_manifest_no_update_v1 BEFORE UPDATE ON paired_nav_frozen_manifests_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_manifest'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_journal_no_update_v1 BEFORE UPDATE ON paired_nav_daily_journal_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_journal'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_parts_no_delete_v1 BEFORE DELETE ON paired_nav_frozen_parts_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_part'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_manifest_no_delete_v1 BEFORE DELETE ON paired_nav_frozen_manifests_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_manifest'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_journal_no_delete_v1 BEFORE DELETE ON paired_nav_daily_journal_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_journal'); END;

-- SQLite REPLACE can bypass DELETE triggers when recursive_triggers is off.
-- Intercept every conflicting INSERT before conflict resolution. An identical
-- retry is ignored (preserving the first timestamp); different evidence aborts.
CREATE TRIGGER IF NOT EXISTS paired_nav_parts_no_replace_v1 BEFORE INSERT ON paired_nav_frozen_parts_v1
WHEN EXISTS (SELECT 1 FROM paired_nav_frozen_parts_v1 p WHERE p.snapshot_id=NEW.snapshot_id AND p.part_no=NEW.part_no)
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM paired_nav_frozen_parts_v1 p
    WHERE p.snapshot_id=NEW.snapshot_id AND p.part_no=NEW.part_no AND p.payload_text=NEW.payload_text)
    THEN RAISE(IGNORE) ELSE RAISE(ABORT,'paired_nav_immutable_part') END;
END;
CREATE TRIGGER IF NOT EXISTS paired_nav_manifest_no_replace_v1 BEFORE INSERT ON paired_nav_frozen_manifests_v1
WHEN EXISTS (SELECT 1 FROM paired_nav_frozen_manifests_v1 m WHERE m.snapshot_id=NEW.snapshot_id
  OR (m.signal_date=NEW.signal_date AND m.source_run_id=NEW.source_run_id AND m.snapshot_kind=NEW.snapshot_kind))
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM paired_nav_frozen_manifests_v1 m
    WHERE m.snapshot_id=NEW.snapshot_id AND m.signal_date=NEW.signal_date
      AND m.source_run_id=NEW.source_run_id AND m.payload_checksum=NEW.payload_checksum
      AND m.part_count=NEW.part_count AND m.prospective=NEW.prospective
      AND m.snapshot_kind=NEW.snapshot_kind AND m.parent_snapshot_id IS NEW.parent_snapshot_id)
    THEN RAISE(IGNORE) ELSE RAISE(ABORT,'paired_nav_immutable_manifest') END;
END;
CREATE TRIGGER IF NOT EXISTS paired_nav_journal_no_replace_v1 BEFORE INSERT ON paired_nav_daily_journal_v1
WHEN EXISTS (SELECT 1 FROM paired_nav_daily_journal_v1 j WHERE j.pair_id=NEW.pair_id
  AND (j.session_date=NEW.session_date OR j.snapshot_id=NEW.snapshot_id))
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM paired_nav_daily_journal_v1 j
    WHERE j.pair_id=NEW.pair_id AND j.session_date=NEW.session_date AND j.snapshot_id=NEW.snapshot_id
      AND j.previous_checksum IS NEW.previous_checksum AND j.payload_json=NEW.payload_json
      AND j.payload_checksum=NEW.payload_checksum)
    THEN RAISE(IGNORE) ELSE RAISE(ABORT,'paired_nav_immutable_journal') END;
END;
