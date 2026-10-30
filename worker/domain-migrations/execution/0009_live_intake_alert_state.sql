-- R21 ops alert state (Wei 10/30): one row per alert, day and reason while the condition lasts.
-- A pass writes the ops log only when its insert added the row (that reason was not
-- logged yet that day); the token it wrote proves which overlapping pass won. Recovery deletes
-- the alert's rows, so the next failure is logged again. console output is not gated by this table.
CREATE TABLE IF NOT EXISTS live_intake_alert_state_v1 (
  alert TEXT NOT NULL CHECK(length(alert) BETWEEN 1 AND 100),
  alert_day TEXT NOT NULL CHECK(length(alert_day) = 10),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
  token TEXT NOT NULL CHECK(length(token) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (alert, alert_day, reason)
);
