-- Budget reservations, NOT statistical PASS receipts or serving authority.
-- A training-cohort/owner family retains its budget across candidate/config
-- revisions and retries. Historical observations cannot register a new trial.
CREATE TABLE IF NOT EXISTS paired_nav_nominations_v1 (
  pair_id TEXT PRIMARY KEY, hypothesis_checksum TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL, family_ordinal INTEGER NOT NULL CHECK(family_ordinal > 0),
  signal_date TEXT NOT NULL, allocation_snapshot_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_checksum TEXT NOT NULL,
  UNIQUE(family_id,family_ordinal)
);
CREATE TABLE IF NOT EXISTS paired_nav_assessment_reservations_v1 (
  pair_id TEXT NOT NULL, session_date TEXT NOT NULL,
  look_ordinal INTEGER NOT NULL CHECK(look_ordinal > 0),
  journal_checksum TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_checksum TEXT NOT NULL,
  PRIMARY KEY(pair_id,session_date), UNIQUE(pair_id,look_ordinal)
);
CREATE TRIGGER IF NOT EXISTS nav_nomination_no_update_v1 BEFORE UPDATE ON paired_nav_nominations_v1
BEGIN SELECT RAISE(ABORT,'nav_nomination_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_nomination_no_delete_v1 BEFORE DELETE ON paired_nav_nominations_v1
BEGIN SELECT RAISE(ABORT,'nav_nomination_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_nomination_no_replace_v1 BEFORE INSERT ON paired_nav_nominations_v1
WHEN EXISTS (SELECT 1 FROM paired_nav_nominations_v1 n WHERE n.pair_id=NEW.pair_id
  OR n.hypothesis_checksum=NEW.hypothesis_checksum
  OR (n.family_id=NEW.family_id AND n.family_ordinal=NEW.family_ordinal))
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM paired_nav_nominations_v1 n
    WHERE n.pair_id=NEW.pair_id AND n.hypothesis_checksum=NEW.hypothesis_checksum
      AND n.family_id=NEW.family_id AND n.family_ordinal=NEW.family_ordinal
      AND n.signal_date=NEW.signal_date AND n.allocation_snapshot_id=NEW.allocation_snapshot_id
      AND n.payload_json=NEW.payload_json AND n.payload_checksum=NEW.payload_checksum)
    THEN RAISE(IGNORE) ELSE RAISE(ABORT,'nav_nomination_immutable') END;
END;
CREATE TRIGGER IF NOT EXISTS nav_assessment_no_update_v1 BEFORE UPDATE ON paired_nav_assessment_reservations_v1
BEGIN SELECT RAISE(ABORT,'nav_assessment_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_assessment_no_delete_v1 BEFORE DELETE ON paired_nav_assessment_reservations_v1
BEGIN SELECT RAISE(ABORT,'nav_assessment_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_assessment_no_replace_v1 BEFORE INSERT ON paired_nav_assessment_reservations_v1
WHEN EXISTS (SELECT 1 FROM paired_nav_assessment_reservations_v1 a WHERE a.pair_id=NEW.pair_id
  AND (a.session_date=NEW.session_date OR a.look_ordinal=NEW.look_ordinal))
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM paired_nav_assessment_reservations_v1 a
    WHERE a.pair_id=NEW.pair_id AND a.session_date=NEW.session_date AND a.look_ordinal=NEW.look_ordinal
      AND a.journal_checksum=NEW.journal_checksum AND a.payload_json=NEW.payload_json
      AND a.payload_checksum=NEW.payload_checksum)
    THEN RAISE(IGNORE) ELSE RAISE(ABORT,'nav_assessment_immutable') END;
END;
