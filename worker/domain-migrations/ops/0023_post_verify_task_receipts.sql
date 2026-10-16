-- Task receipts are not scheduler locks. No TTL/reaper may clear an unresolved
-- producer; elapsed time does not prove its side effects stopped.
CREATE TABLE IF NOT EXISTS post_verify_task_receipts_v1 (
  receipt_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('post_verify_task_v1:running','post_verify_task_v1:success','post_verify_task_v1:error','post_verify_task_v1:uncertain')),
  business_date TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 32768),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_post_verify_task_receipts_state_date
  ON post_verify_task_receipts_v1(state,business_date);
