-- Numerical NAV review durability. Not a serving gate or the retired0042 budget.
-- A header reserves one immutable slot; all parts must verify before publication.
CREATE TABLE IF NOT EXISTS paired_nav_review_records_v1 (
  record_id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('protocol','reservation','review')),
  protocol_id TEXT NOT NULL, family_id TEXT NOT NULL, review_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL, payload_checksum TEXT NOT NULL,
  part_count INTEGER NOT NULL CHECK(part_count > 0), created_at TEXT NOT NULL,
  CHECK((record_kind='protocol' AND family_id='' AND review_id='')
     OR (record_kind IN ('reservation','review') AND family_id<>'' AND review_id<>'')),
  UNIQUE(protocol_id,family_id,review_id,record_kind)
);
CREATE TABLE IF NOT EXISTS paired_nav_review_parts_v1 (
  record_id TEXT NOT NULL, part_no INTEGER NOT NULL CHECK(part_no >= 0),
  payload_text TEXT NOT NULL, PRIMARY KEY(record_id,part_no)
);
CREATE TRIGGER IF NOT EXISTS nav_review_record_no_update_v1 BEFORE UPDATE ON paired_nav_review_records_v1
BEGIN SELECT RAISE(ABORT,'nav_review_record_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_review_record_no_delete_v1 BEFORE DELETE ON paired_nav_review_records_v1
BEGIN SELECT RAISE(ABORT,'nav_review_record_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_review_record_no_replace_v1 BEFORE INSERT ON paired_nav_review_records_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_review_records_v1 r WHERE r.record_id=NEW.record_id
 OR (r.protocol_id=NEW.protocol_id AND r.family_id=NEW.family_id AND r.review_id=NEW.review_id AND r.record_kind=NEW.record_kind))
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM paired_nav_review_records_v1 r
  WHERE r.record_id=NEW.record_id AND r.record_kind=NEW.record_kind
  AND r.protocol_id=NEW.protocol_id AND r.family_id=NEW.family_id AND r.review_id=NEW.review_id
  AND r.as_of_date=NEW.as_of_date AND r.payload_checksum=NEW.payload_checksum AND r.part_count=NEW.part_count)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'nav_review_record_immutable') END;
END;
CREATE TRIGGER IF NOT EXISTS nav_review_part_no_update_v1 BEFORE UPDATE ON paired_nav_review_parts_v1
BEGIN SELECT RAISE(ABORT,'nav_review_part_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_review_part_no_delete_v1 BEFORE DELETE ON paired_nav_review_parts_v1
BEGIN SELECT RAISE(ABORT,'nav_review_part_immutable'); END;
CREATE TRIGGER IF NOT EXISTS nav_review_part_no_replace_v1 BEFORE INSERT ON paired_nav_review_parts_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_review_parts_v1 p WHERE p.record_id=NEW.record_id AND p.part_no=NEW.part_no)
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM paired_nav_review_parts_v1 p
  WHERE p.record_id=NEW.record_id AND p.part_no=NEW.part_no AND p.payload_text=NEW.payload_text)
 THEN RAISE(IGNORE) ELSE RAISE(ABORT,'nav_review_part_immutable') END;
END;
