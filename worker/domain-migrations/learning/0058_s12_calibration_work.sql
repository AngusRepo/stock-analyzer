-- Bounded calibration scratch; source tables and cold release authority are unchanged.
CREATE TABLE IF NOT EXISTS s12_calibration_work_v1 (
 run_id TEXT PRIMARY KEY, run_date TEXT NOT NULL, cadence TEXT NOT NULL,
 start_date TEXT NOT NULL, snapshot_at TEXT NOT NULL, contract TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('reading','ready','committed','deferred','expired')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), commit_token TEXT NOT NULL,
 cold_upper INTEGER NOT NULL, cold_batches INTEGER NOT NULL, cold_rows INTEGER NOT NULL,
 checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
 retained_rows INTEGER NOT NULL DEFAULT 0 CHECK(retained_rows BETWEEN 0 AND 100000),
 retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK(retained_bytes BETWEEN 0 AND 67108864),
 capture_valid INTEGER NOT NULL CHECK(capture_valid=1),
 scratch_valid INTEGER NOT NULL DEFAULT 1 CHECK(scratch_valid=1),
 updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS s12_calibration_work_identity_v1 BEFORE UPDATE ON s12_calibration_work_v1
 WHEN NEW.run_id IS NOT OLD.run_id OR NEW.run_date IS NOT OLD.run_date OR NEW.cadence IS NOT OLD.cadence
 OR NEW.start_date IS NOT OLD.start_date OR NEW.snapshot_at IS NOT OLD.snapshot_at OR NEW.contract IS NOT OLD.contract
 OR NEW.cold_upper IS NOT OLD.cold_upper OR NEW.cold_batches IS NOT OLD.cold_batches OR NEW.cold_rows IS NOT OLD.cold_rows
 OR (OLD.phase IN ('committed','deferred','expired') AND NEW.phase<>OLD.phase)
 BEGIN SELECT RAISE(ABORT,'s12_calibration_frozen_identity'); END;
CREATE TRIGGER IF NOT EXISTS s12_calibration_work_no_delete_v1 BEFORE DELETE ON s12_calibration_work_v1
 BEGIN SELECT RAISE(ABORT,'s12_calibration_work_receipt_required'); END;
CREATE TABLE IF NOT EXISTS s12_calibration_work_rows_v1 (
 run_id TEXT NOT NULL REFERENCES s12_calibration_work_v1(run_id), id INTEGER NOT NULL,
 row_json TEXT NOT NULL CHECK(json_valid(row_json)), payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 32768),
 PRIMARY KEY(run_id,id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS s12_calibration_work_lifecycle_v1 (
 run_id TEXT NOT NULL REFERENCES s12_calibration_work_v1(run_id), business_date TEXT NOT NULL,
 state TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(run_id,business_date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS s12_calibration_work_censor_v1 (
 run_id TEXT NOT NULL REFERENCES s12_calibration_work_v1(run_id), signal_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('complete','pending','recent','stale','missing','ignored')),
 rows INTEGER NOT NULL CHECK(rows>=0), PRIMARY KEY(run_id,signal_key,kind)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS s12_calibration_work_rows_immutable_v1 BEFORE UPDATE ON s12_calibration_work_rows_v1
 BEGIN SELECT RAISE(ABORT,'s12_calibration_frozen_row'); END;
CREATE TRIGGER IF NOT EXISTS s12_calibration_work_lifecycle_immutable_v1 BEFORE UPDATE ON s12_calibration_work_lifecycle_v1
 BEGIN SELECT RAISE(ABORT,'s12_calibration_frozen_lifecycle'); END;

CREATE TABLE IF NOT EXISTS s12_calibration_work_current_v1 (
 canonical_run_id TEXT PRIMARY KEY, work_id TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_s12_calibration_work_progress_v1 ON s12_calibration_work_v1(phase,updated_at);
-- INSERT OR REPLACE must not bypass immutable UPDATE guards when recursive_triggers is off.
CREATE TRIGGER IF NOT EXISTS s12_calibration_work_no_replace_v1 BEFORE INSERT ON s12_calibration_work_v1
 WHEN EXISTS(SELECT 1 FROM s12_calibration_work_v1 WHERE run_id=NEW.run_id)
 BEGIN SELECT RAISE(ABORT,'s12_calibration_frozen_identity'); END;
CREATE TRIGGER IF NOT EXISTS s12_calibration_work_rows_no_replace_v1 BEFORE INSERT ON s12_calibration_work_rows_v1
 WHEN EXISTS(SELECT 1 FROM s12_calibration_work_rows_v1 WHERE run_id=NEW.run_id AND id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'s12_calibration_frozen_row'); END;
CREATE TRIGGER IF NOT EXISTS s12_calibration_work_lifecycle_no_replace_v1 BEFORE INSERT ON s12_calibration_work_lifecycle_v1
 WHEN EXISTS(SELECT 1 FROM s12_calibration_work_lifecycle_v1 WHERE run_id=NEW.run_id AND business_date=NEW.business_date)
 BEGIN SELECT RAISE(ABORT,'s12_calibration_frozen_lifecycle'); END;
