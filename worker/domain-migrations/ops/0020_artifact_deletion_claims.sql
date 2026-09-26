-- A durable delete claim serializes R2 expiry with new pins/references in the same Ops database.
CREATE TABLE IF NOT EXISTS artifact_deletion_claims_v1 (
 artifact_id TEXT PRIMARY KEY REFERENCES run_artifacts(artifact_id),
 r2_key TEXT NOT NULL UNIQUE,
 checksum TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','done')),
 owner_id TEXT,
 lease_until TEXT NOT NULL,
 next_attempt_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 claimed_at TEXT NOT NULL,
 last_attempt_at TEXT,
 completed_at TEXT,
 last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifact_delete_due_v1 ON artifact_deletion_claims_v1(status,next_attempt_at,lease_until);
CREATE TRIGGER IF NOT EXISTS artifact_delete_identity_frozen_v1 BEFORE UPDATE ON artifact_deletion_claims_v1
 WHEN NEW.artifact_id IS NOT OLD.artifact_id OR NEW.r2_key IS NOT OLD.r2_key OR NEW.checksum IS NOT OLD.checksum
  OR NEW.claimed_at IS NOT OLD.claimed_at OR (OLD.status='done' AND NEW.status<>'done')
 BEGIN SELECT RAISE(ABORT,'artifact_delete_claim_immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_delete_claim_no_delete_v1 BEFORE DELETE ON artifact_deletion_claims_v1
 BEGIN SELECT RAISE(ABORT,'artifact_delete_claim_immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_delete_claim_no_replace_v1 BEFORE INSERT ON artifact_deletion_claims_v1
 WHEN EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=NEW.artifact_id OR c.r2_key=NEW.r2_key)
 BEGIN SELECT RAISE(ABORT,'artifact_delete_claim_immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_delete_new_reference_v1 BEFORE INSERT ON artifact_hard_references
 WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=NEW.artifact_id)
 BEGIN SELECT RAISE(ABORT,'artifact_delete_in_progress_or_done'); END;
CREATE TRIGGER IF NOT EXISTS artifact_delete_reactivate_reference_v1 BEFORE UPDATE ON artifact_hard_references
 WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=NEW.artifact_id)
 BEGIN SELECT RAISE(ABORT,'artifact_delete_in_progress_or_done'); END;
CREATE TRIGGER IF NOT EXISTS artifact_delete_no_republish_v1 BEFORE INSERT ON run_artifacts
 WHEN EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=NEW.artifact_id OR c.r2_key=NEW.r2_key)
 BEGIN SELECT RAISE(ABORT,'artifact_delete_in_progress_or_done'); END;
CREATE TRIGGER IF NOT EXISTS artifact_delete_protected_update_v1 BEFORE UPDATE ON run_artifacts
 WHEN EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=OLD.artifact_id)
  AND (NEW.artifact_id IS NOT OLD.artifact_id OR NEW.r2_key IS NOT OLD.r2_key OR NEW.checksum IS NOT OLD.checksum
    OR NEW.retain_until IS NOT OLD.retain_until OR NEW.pinned<>0 OR NEW.legal_hold<>0 OR NEW.hard_ref_count<>0
    OR (NEW.status IS NOT OLD.status AND NEW.status<>'payload_deleted')
    OR (OLD.payload_deleted_at IS NOT NULL AND NEW.payload_deleted_at IS NULL))
 BEGIN SELECT RAISE(ABORT,'artifact_delete_in_progress_or_done'); END;
-- Legacy tombstones also prohibit accidental republishing; this does not delete any payload.
INSERT INTO artifact_deletion_claims_v1
 (artifact_id,r2_key,checksum,status,lease_until,next_attempt_at,claimed_at,completed_at)
 SELECT a.artifact_id,a.r2_key,a.checksum,'done',COALESCE(a.payload_deleted_at,a.updated_at),
  COALESCE(a.payload_deleted_at,a.updated_at),COALESCE(a.payload_deleted_at,a.updated_at),COALESCE(a.payload_deleted_at,a.updated_at)
 FROM run_artifacts a WHERE (a.status='payload_deleted' OR a.payload_deleted_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=a.artifact_id);
