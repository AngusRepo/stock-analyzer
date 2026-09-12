-- Publication receipts for the ORIGINAL strategy registry and weight owner.
-- No model artifacts, new evaluator, or fabricated legacy Edge/V7 statistics.
CREATE TABLE IF NOT EXISTS strategy_atomic_nav_adoptions_v1 (
  artifact_checksum TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL UNIQUE,
  decision_checksum TEXT NOT NULL,
  policy_checksum TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  receipt_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS strategy_atomic_nav_adoptions_no_update_v1
BEFORE UPDATE ON strategy_atomic_nav_adoptions_v1
BEGIN SELECT RAISE(ABORT,'strategy_atomic_nav_immutable_receipt'); END;
CREATE TRIGGER IF NOT EXISTS strategy_atomic_nav_adoptions_no_delete_v1
BEFORE DELETE ON strategy_atomic_nav_adoptions_v1
BEGIN SELECT RAISE(ABORT,'strategy_atomic_nav_immutable_receipt'); END;
CREATE TRIGGER IF NOT EXISTS strategy_atomic_nav_adoptions_no_replace_v1
BEFORE INSERT ON strategy_atomic_nav_adoptions_v1
WHEN EXISTS(SELECT 1 FROM strategy_atomic_nav_adoptions_v1 WHERE artifact_checksum=NEW.artifact_checksum)
BEGIN SELECT RAISE(ABORT,'strategy_atomic_nav_immutable_receipt'); END;
