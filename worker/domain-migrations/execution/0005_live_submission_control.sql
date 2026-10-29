-- R17: append-only Live submission control (one-click pause, Wei-scoped resume).
-- The latest row decides. A missing, broken or unreadable chain means paused.
-- Pausing stops new Live buy and sell orders; submitted broker orders keep
-- reconciling and positions are not touched (Wei D-7). Paper books untouched.
CREATE TABLE IF NOT EXISTS live_submission_control_v1 (
  sequence INTEGER PRIMARY KEY CHECK(sequence >= 1),
  action TEXT NOT NULL CHECK(action IN ('pause','resume')),
  request_id TEXT NOT NULL UNIQUE CHECK(length(request_id) BETWEEN 1 AND 128),
  actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 160),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  approval_scope TEXT,
  approval_expires_at TEXT,
  gate_receipt_sha256 TEXT,
  created_at TEXT NOT NULL,
  previous_sha256 TEXT NOT NULL CHECK(length(previous_sha256) = 64),
  row_sha256 TEXT NOT NULL UNIQUE CHECK(length(row_sha256) = 64),
  CHECK(
    (action = 'pause' AND approval_scope IS NULL AND approval_expires_at IS NULL AND gate_receipt_sha256 IS NULL)
    OR (action = 'resume' AND COALESCE(length(approval_scope) > 0, 0) AND COALESCE(length(approval_expires_at) > 0, 0)
        AND COALESCE(length(gate_receipt_sha256) = 64, 0))
  )
);
CREATE TRIGGER IF NOT EXISTS live_submission_control_v1_no_update
BEFORE UPDATE ON live_submission_control_v1 BEGIN SELECT RAISE(ABORT,'live_submission_control_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_submission_control_v1_no_delete
BEFORE DELETE ON live_submission_control_v1 BEGIN SELECT RAISE(ABORT,'live_submission_control_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_submission_control_v1_append_only
BEFORE INSERT ON live_submission_control_v1
WHEN NEW.sequence != COALESCE((SELECT MAX(sequence) FROM live_submission_control_v1), 0) + 1
  OR NEW.previous_sha256 != COALESCE(
    (SELECT row_sha256 FROM live_submission_control_v1 ORDER BY sequence DESC LIMIT 1),
    '0000000000000000000000000000000000000000000000000000000000000000')
BEGIN SELECT RAISE(ABORT,'live_submission_control_chain_conflict'); END;
-- Live starts paused. row_sha256 = sha256(canonical JSON of every other column).
INSERT INTO live_submission_control_v1
  (sequence, action, request_id, actor, reason, approval_scope, approval_expires_at,
   gate_receipt_sha256, created_at, previous_sha256, row_sha256)
SELECT 1, 'pause', 'initial_seed', 'migration:0005', 'live_submission_closed_until_r4_gate_resume',
  NULL, NULL, NULL, '1970-01-01T00:00:00+00:00',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'e68bdd3b291c7771b50e3e2c9892002d0ef4fb98c9c69f1b67b012a90e1ec9dd'
WHERE NOT EXISTS (SELECT 1 FROM live_submission_control_v1);
