-- Cold payloads are verified and held for at least 3650 days; original manifests stay immutable.
CREATE TABLE IF NOT EXISTS paired_nav_cold_objects_v1 (
 snapshot_id TEXT PRIMARY KEY, payload_checksum TEXT NOT NULL, object_key TEXT NOT NULL,
 payload_bytes INTEGER NOT NULL CHECK(payload_bytes>0), original_part_count INTEGER NOT NULL CHECK(original_part_count>0),
 view_kind TEXT NOT NULL CHECK(view_kind IN ('full','opb_context_v1','allocation_proof_v1','none')),
 view_checksum TEXT NOT NULL, view_part_count INTEGER NOT NULL CHECK(view_part_count>=0),
 verified_at TEXT NOT NULL, retain_until TEXT NOT NULL,
 CHECK(julianday(retain_until)>=julianday(verified_at)+3650)
);
CREATE TABLE IF NOT EXISTS paired_nav_cold_views_v1 (
 snapshot_id TEXT NOT NULL, part_no INTEGER NOT NULL CHECK(part_no>=0), payload_text TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,part_no)
);
CREATE TABLE IF NOT EXISTS paired_nav_hot_releases_v1 (
 snapshot_id TEXT PRIMARY KEY, payload_checksum TEXT NOT NULL, approval_id TEXT NOT NULL CHECK(length(trim(approval_id))>0),
 recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS paired_nav_cold_objects_v1_no_update BEFORE UPDATE ON paired_nav_cold_objects_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_cold_objects_v1_no_delete BEFORE DELETE ON paired_nav_cold_objects_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_cold_objects_v1_no_replace BEFORE INSERT ON paired_nav_cold_objects_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_cold_objects_v1 p WHERE p.snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM paired_nav_cold_objects_v1 p WHERE p.snapshot_id=NEW.snapshot_id AND p.payload_checksum=NEW.payload_checksum AND p.object_key=NEW.object_key AND p.payload_bytes=NEW.payload_bytes AND p.original_part_count=NEW.original_part_count AND p.view_kind=NEW.view_kind AND p.view_checksum=NEW.view_checksum AND p.view_part_count=NEW.view_part_count); SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_cold_views_v1_no_update BEFORE UPDATE ON paired_nav_cold_views_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_cold_views_v1_no_delete BEFORE DELETE ON paired_nav_cold_views_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_cold_views_v1_no_replace BEFORE INSERT ON paired_nav_cold_views_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_cold_views_v1 p WHERE p.snapshot_id=NEW.snapshot_id AND p.part_no=NEW.part_no)
BEGIN SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM paired_nav_cold_views_v1 p WHERE p.snapshot_id=NEW.snapshot_id AND p.part_no=NEW.part_no AND p.payload_text=NEW.payload_text); SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_hot_releases_v1_no_update BEFORE UPDATE ON paired_nav_hot_releases_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_hot_releases_v1_no_delete BEFORE DELETE ON paired_nav_hot_releases_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_hot_releases_v1_no_replace BEFORE INSERT ON paired_nav_hot_releases_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_hot_releases_v1 p WHERE p.snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM paired_nav_hot_releases_v1 p WHERE p.snapshot_id=NEW.snapshot_id AND p.payload_checksum=NEW.payload_checksum AND p.approval_id=NEW.approval_id); SELECT RAISE(ABORT,'paired_nav_immutable_cold'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_hot_release_proof BEFORE INSERT ON paired_nav_hot_releases_v1
WHEN NOT EXISTS(SELECT 1 FROM paired_nav_cold_objects_v1 c JOIN paired_nav_frozen_manifests_v1 m ON m.snapshot_id=c.snapshot_id
 WHERE c.snapshot_id=NEW.snapshot_id AND c.payload_checksum=NEW.payload_checksum AND m.payload_checksum=c.payload_checksum)
BEGIN SELECT RAISE(ABORT,'paired_nav_hot_release_proof_missing'); END;
DROP TRIGGER IF EXISTS paired_nav_parts_no_delete_v1;
CREATE TRIGGER paired_nav_parts_no_delete_v1 BEFORE DELETE ON paired_nav_frozen_parts_v1
WHEN NOT EXISTS(SELECT 1 FROM paired_nav_hot_releases_v1 r JOIN paired_nav_cold_objects_v1 c ON c.snapshot_id=r.snapshot_id
 JOIN paired_nav_frozen_manifests_v1 m ON m.snapshot_id=c.snapshot_id
 WHERE r.snapshot_id=OLD.snapshot_id AND r.payload_checksum=c.payload_checksum AND c.payload_checksum=m.payload_checksum)
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_part'); END;

CREATE TRIGGER IF NOT EXISTS paired_nav_parts_retired_no_insert BEFORE INSERT ON paired_nav_frozen_parts_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_hot_releases_v1 r WHERE r.snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'paired_nav_hot_copy_retired'); END;
