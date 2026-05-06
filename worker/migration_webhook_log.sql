-- migration_webhook_log.sql — 2026-04-20 #10 Phase 1 Webhook idempotency log
--
-- Purpose: dedup webhook callbacks from long-running tasks (Modal retrain, Optuna, etc).
-- Upstream services POST completion events to ml-controller with an idempotency key
-- (typically trained_at / run_id). Controller INSERT OR IGNORE here before triggering
-- any downstream action. Duplicate retries are safely no-op.
--
-- Retention: 90 days (manual cleanup cron or add WHERE received_at < date('now','-90 days')).

CREATE TABLE IF NOT EXISTS webhook_log (
  idempotency_key TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,        -- ISO8601 UTC
  source          TEXT NOT NULL,        -- 'ml-service' | 'optuna' | etc
  action          TEXT NOT NULL,        -- 'retrain_followup' | 'optuna_complete' | ...
  payload_summary TEXT,                 -- JSON string of key fields (avoid full payload bloat)
  status          TEXT NOT NULL,        -- 'logged' | 'triggered' | 'skipped_dup' | 'error'
  downstream_notes TEXT                 -- what action was actually taken
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_received ON webhook_log(received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_log_action   ON webhook_log(action);
