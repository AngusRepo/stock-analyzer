-- Durable, idempotent execution authority for every physical Scheduler root
-- and every future logical DAG child. This table is control-plane metadata;
-- it never grants permission to retrain, deploy, or submit orders.
CREATE TABLE IF NOT EXISTS scheduler_execution_tickets_v1 (
  ticket_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  root_ticket_id TEXT NOT NULL,
  parent_ticket_id TEXT,
  scheduler_job_id TEXT,
  task TEXT NOT NULL,
  business_date TEXT NOT NULL,
  scheduled_at TEXT,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  ticket_kind TEXT NOT NULL CHECK(ticket_kind IN ('physical_root','logical_child','manual')),
  status TEXT NOT NULL CHECK(status IN (
    'accepted','queued','running','triggered','success','error','skipped','blocked'
  )),
  status_authority TEXT NOT NULL CHECK(status_authority IN (
    'scheduler_http','durable_queue','durable_pipeline_stage','logical_child'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count >= 1 AND attempt_count <= 3),
  payload_checksum TEXT NOT NULL,
  last_summary TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+400 days')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduler_execution_tickets_job_date
  ON scheduler_execution_tickets_v1(scheduler_job_id, business_date, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduler_execution_tickets_root
  ON scheduler_execution_tickets_v1(root_ticket_id, parent_ticket_id, created_at);

CREATE INDEX IF NOT EXISTS idx_scheduler_execution_tickets_status
  ON scheduler_execution_tickets_v1(status, business_date, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduler_execution_tickets_expiry
  ON scheduler_execution_tickets_v1(expires_at, status);
