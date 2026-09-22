-- Preserve incomplete writes as forensic fragments, never as a valid NAV snapshot.
CREATE TABLE IF NOT EXISTS paired_nav_orphan_archives_v1 (
 snapshot_id TEXT PRIMARY KEY,
 fragment_checksum TEXT NOT NULL CHECK(length(fragment_checksum)=64),
 object_key TEXT NOT NULL,
 object_bytes INTEGER NOT NULL CHECK(object_bytes>0),
 fragment_count INTEGER NOT NULL CHECK(fragment_count>0),
 verified_at TEXT NOT NULL,
 retain_until TEXT NOT NULL,
 approval_id TEXT NOT NULL CHECK(length(trim(approval_id))>0),
 CHECK(julianday(retain_until)>=julianday(verified_at)+3650)
);
CREATE TRIGGER IF NOT EXISTS paired_nav_orphan_archive_no_update BEFORE UPDATE ON paired_nav_orphan_archives_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_orphan_archive'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_orphan_archive_no_delete BEFORE DELETE ON paired_nav_orphan_archives_v1
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_orphan_archive'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_orphan_archive_guard BEFORE INSERT ON paired_nav_orphan_archives_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=NEW.snapshot_id)
 OR (SELECT COUNT(*) FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=NEW.snapshot_id)<>NEW.fragment_count
 OR COALESCE((SELECT MIN(part_no) FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=NEW.snapshot_id),-1)<>0
 OR COALESCE((SELECT MAX(part_no) FROM paired_nav_frozen_parts_v1 WHERE snapshot_id=NEW.snapshot_id),-1)<>NEW.fragment_count-1
BEGIN SELECT RAISE(ABORT,'paired_nav_orphan_source_changed'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_orphan_archive_no_replace BEFORE INSERT ON paired_nav_orphan_archives_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_orphan_archives_v1 WHERE snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_orphan_archive'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_orphan_retired_no_part BEFORE INSERT ON paired_nav_frozen_parts_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_orphan_archives_v1 WHERE snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'paired_nav_orphan_retired'); END;
CREATE TRIGGER IF NOT EXISTS paired_nav_orphan_retired_no_manifest BEFORE INSERT ON paired_nav_frozen_manifests_v1
WHEN EXISTS(SELECT 1 FROM paired_nav_orphan_archives_v1 WHERE snapshot_id=NEW.snapshot_id)
BEGIN SELECT RAISE(ABORT,'paired_nav_orphan_cannot_become_snapshot'); END;
DROP TRIGGER IF EXISTS paired_nav_parts_no_delete_v1;
CREATE TRIGGER IF NOT EXISTS paired_nav_parts_no_delete_v1 BEFORE DELETE ON paired_nav_frozen_parts_v1
WHEN NOT EXISTS(SELECT 1 FROM paired_nav_hot_releases_v1 r JOIN paired_nav_cold_objects_v1 c ON c.snapshot_id=r.snapshot_id
 JOIN paired_nav_frozen_manifests_v1 m ON m.snapshot_id=c.snapshot_id
 WHERE r.snapshot_id=OLD.snapshot_id AND r.payload_checksum=c.payload_checksum AND c.payload_checksum=m.payload_checksum)
 AND NOT EXISTS(SELECT 1 FROM paired_nav_orphan_archives_v1 a
 WHERE a.snapshot_id=OLD.snapshot_id AND OLD.part_no>=0 AND OLD.part_no<a.fragment_count
 AND NOT EXISTS(SELECT 1 FROM paired_nav_frozen_manifests_v1 m WHERE m.snapshot_id=a.snapshot_id))
BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_part'); END;
