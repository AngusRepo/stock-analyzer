-- Generated from schema.sql plus production snapshot fallback; do not edit by hand.
CREATE TABLE IF NOT EXISTS broker_execution_intents (
  intent_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  status TEXT NOT NULL CHECK(status IN ('RESERVED','REVALIDATED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN','BLOCKED')),
  packet_hash TEXT NOT NULL,
  approval_scope TEXT NOT NULL,
  requested_shares INTEGER NOT NULL,
  limit_price REAL NOT NULL,
  intent_json TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_broker_intents_trade_side ON broker_execution_intents(trade_date, side, status);

CREATE INDEX IF NOT EXISTS idx_broker_intents_symbol ON broker_execution_intents(trade_date, symbol, side);

CREATE TABLE IF NOT EXISTS broker_execution_legs (
  leg_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES broker_execution_intents(intent_id),
  leg_key TEXT NOT NULL,
  client_tag TEXT NOT NULL UNIQUE,
  lot_type TEXT NOT NULL CHECK(lot_type IN ('board_lot','odd_lot')),
  requested_shares INTEGER NOT NULL,
  broker_quantity INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RESERVED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN')),
  broker_order_id TEXT,
  submit_attempts INTEGER NOT NULL DEFAULT 0,
  filled_shares INTEGER NOT NULL DEFAULT 0,
  average_fill_price REAL,
  last_error TEXT,
  claimed_at TEXT,
  acknowledged_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(intent_id, leg_key),
  UNIQUE(broker_order_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_legs_recovery ON broker_execution_legs(status, updated_at);

CREATE TABLE IF NOT EXISTS broker_execution_events (
  event_id TEXT PRIMARY KEY,
  intent_id TEXT,
  leg_id TEXT,
  broker_order_id TEXT,
  client_tag TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('INTENT_RESERVED','LEG_CLAIMED','SUBMIT_ACK','SUBMIT_UNKNOWN','SUBMIT_REJECTED','ORDER_CALLBACK','DEAL_CALLBACK','STATUS_RECONCILIATION','CONNECTION_STATE','RECOVERY')),
  event_status TEXT NOT NULL,
  event_time TEXT NOT NULL,
  exchange_sequence TEXT,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(intent_id) REFERENCES broker_execution_intents(intent_id),
  FOREIGN KEY(leg_id) REFERENCES broker_execution_legs(leg_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_events_order_time ON broker_execution_events(broker_order_id, event_time);

CREATE INDEX IF NOT EXISTS idx_broker_events_client_tag ON broker_execution_events(client_tag, event_time);

CREATE INDEX IF NOT EXISTS idx_broker_events_unmatched ON broker_execution_events(broker_order_id, leg_id);

CREATE TABLE IF NOT EXISTS risk_audit_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp             TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_event         TEXT NOT NULL,
  account_id            INTEGER NOT NULL DEFAULT 1,
  symbol                TEXT,
  side                  TEXT,
  decision              TEXT NOT NULL,
  halt                  INTEGER NOT NULL DEFAULT 0,
  triggered_count       INTEGER NOT NULL DEFAULT 0,
  severity              TEXT NOT NULL DEFAULT 'normal',
  max_position_pct      REAL,
  buy_conf_threshold    REAL,
  sell_conf_threshold   REAL,
  risk_state_json       TEXT NOT NULL,
  order_validation_json TEXT,
  config_version        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_audit_ts       ON risk_audit_log(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_risk_audit_halt     ON risk_audit_log(halt, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_risk_audit_sev      ON risk_audit_log(severity, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_risk_audit_trigger  ON risk_audit_log(trigger_event, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_risk_audit_symbol   ON risk_audit_log(symbol, timestamp DESC);

-- A receipt is inserted in the SAME source D1 transaction as exact row deletion.
CREATE TABLE IF NOT EXISTS execution_retention_releases_v1 (
 artifact_id TEXT PRIMARY KEY,
 checksum TEXT NOT NULL,
 dataset_id TEXT NOT NULL,
 row_count INTEGER NOT NULL CHECK(row_count > 0 AND row_count <= 250),
 released_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS execution_retention_releases_v1_immutable_update
 BEFORE UPDATE ON execution_retention_releases_v1 BEGIN SELECT RAISE(ABORT,'retention_release_immutable'); END;
CREATE TRIGGER IF NOT EXISTS execution_retention_releases_v1_immutable_delete
 BEFORE DELETE ON execution_retention_releases_v1 BEGIN SELECT RAISE(ABORT,'retention_release_immutable'); END;
CREATE TRIGGER IF NOT EXISTS execution_retention_releases_v1_immutable_replace
 BEFORE INSERT ON execution_retention_releases_v1 WHEN EXISTS(SELECT 1 FROM execution_retention_releases_v1 WHERE artifact_id=NEW.artifact_id)
 BEGIN SELECT RAISE(ABORT,'retention_release_immutable'); END;

CREATE INDEX IF NOT EXISTS idx_broker_events_intent_retention ON broker_execution_events(intent_id);
CREATE INDEX IF NOT EXISTS idx_broker_events_leg_retention ON broker_execution_events(leg_id);

CREATE INDEX IF NOT EXISTS idx_execution_retention_release_lookup
ON execution_retention_releases_v1(dataset_id,released_at,artifact_id);

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

-- Live account source observations; never reuse Paper cash, positions or NAV.
CREATE TABLE IF NOT EXISTS live_account_observations_v1 (
    account_scope TEXT NOT NULL CHECK(account_scope LIKE 'live:sinopac:%'),
    request_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(account_scope, request_id)
);
CREATE INDEX IF NOT EXISTS idx_live_account_observations_time
ON live_account_observations_v1(account_scope, observed_at);
CREATE TRIGGER IF NOT EXISTS live_account_observations_no_update
BEFORE UPDATE ON live_account_observations_v1 BEGIN SELECT RAISE(ABORT,'live_account_observation_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_account_observations_no_delete
BEFORE DELETE ON live_account_observations_v1 BEGIN SELECT RAISE(ABORT,'live_account_observation_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_account_observations_no_replace
BEFORE INSERT ON live_account_observations_v1
WHEN EXISTS(SELECT 1 FROM live_account_observations_v1
            WHERE account_scope=NEW.account_scope AND request_id=NEW.request_id)
     AND EXISTS(SELECT 1 FROM live_account_observations_v1
                WHERE account_scope=NEW.account_scope AND request_id=NEW.request_id
                AND (sha256!=NEW.sha256 OR payload_json!=NEW.payload_json OR observed_at!=NEW.observed_at))
BEGIN SELECT RAISE(ABORT,'live_account_observation_conflict'); END;

-- R18 / NEW-H1g: Live ledger, separate from every Paper table.
-- External cash flows are recorded explicitly so NAV return and drawdown are
-- flow-adjusted (time-weighted) instead of treating deposits as gains.
CREATE TABLE IF NOT EXISTS live_cash_flows_v1 (
  flow_id TEXT PRIMARY KEY CHECK(length(flow_id) BETWEEN 1 AND 128),
  account_scope TEXT NOT NULL CHECK(account_scope LIKE 'live:sinopac:%'),
  flow_date TEXT NOT NULL CHECK(flow_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK(kind IN ('deposit','withdrawal')),
  amount REAL NOT NULL CHECK(amount = CAST(amount AS INTEGER)),
  source TEXT NOT NULL CHECK(source IN ('wei_manual','broker_statement')),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256) = 64),
  recorded_at TEXT NOT NULL,
  CHECK((kind = 'deposit' AND amount > 0) OR (kind = 'withdrawal' AND amount < 0))
);
CREATE INDEX IF NOT EXISTS idx_live_cash_flows_date ON live_cash_flows_v1(account_scope, flow_date);
CREATE TRIGGER IF NOT EXISTS live_cash_flows_v1_no_update
BEFORE UPDATE ON live_cash_flows_v1 BEGIN SELECT RAISE(ABORT,'live_cash_flow_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_cash_flows_v1_no_delete
BEFORE DELETE ON live_cash_flows_v1 BEGIN SELECT RAISE(ABORT,'live_cash_flow_immutable'); END;

CREATE TABLE IF NOT EXISTS live_daily_snapshots_v1 (
  account_scope TEXT NOT NULL CHECK(account_scope LIKE 'live:sinopac:%'),
  business_date TEXT NOT NULL CHECK(business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  observation_sha256 TEXT NOT NULL CHECK(length(observation_sha256) = 64),
  cash REAL NOT NULL,
  unsettled_net REAL NOT NULL,
  positions_value REAL NOT NULL CHECK(positions_value >= 0),
  nav REAL NOT NULL CHECK(nav >= 0),
  net_external_flow REAL NOT NULL,
  return_index REAL NOT NULL CHECK(return_index > 0),
  peak_return_index REAL NOT NULL CHECK(peak_return_index >= return_index),
  drawdown REAL NOT NULL CHECK(drawdown <= 0),
  marks_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_scope, business_date)
);
CREATE TRIGGER IF NOT EXISTS live_daily_snapshots_v1_no_update
BEFORE UPDATE ON live_daily_snapshots_v1 BEGIN SELECT RAISE(ABORT,'live_daily_snapshot_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_daily_snapshots_v1_no_delete
BEFORE DELETE ON live_daily_snapshots_v1 BEGIN SELECT RAISE(ABORT,'live_daily_snapshot_immutable'); END;

-- R21: one row per Paper order the Live path has seen. Live never re-runs the
-- allocator; it scales the committed Paper order (Wei D-6) and records why.
-- The conversion is immutable; only the processing status may advance.
-- UNKNOWN is reconcile-only: it can settle to RELAYED or BLOCKED, never back to
-- a sendable state, so an unclear submission is never sent again. One exception: a
-- sell the gateway answered "blocked" before reserving any intent (no broker order
-- exists) returns to DEFERRED, so a Paper exit is re-validated next day, not lost.
-- sent_on is the Taiwan date of the last send, for same-day reservations.
CREATE TABLE IF NOT EXISTS live_intake_orders_v1 (
  paper_order_ref TEXT PRIMARY KEY CHECK(length(paper_order_ref) BETWEEN 1 AND 200),
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  paper_shares INTEGER NOT NULL CHECK(paper_shares > 0),
  live_shares INTEGER NOT NULL CHECK(live_shares >= 0),
  idempotency_key TEXT UNIQUE,
  conversion_json TEXT NOT NULL,
  conversion_sha256 TEXT NOT NULL CHECK(length(conversion_sha256) = 64),
  status TEXT NOT NULL CHECK(status IN ('RECEIVED','SKIPPED','BLOCKED','DEFERRED','RELAYED','UNKNOWN')),
  status_reason TEXT,
  sent_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_intake_orders_day ON live_intake_orders_v1(trade_date, status);
CREATE TRIGGER IF NOT EXISTS live_intake_orders_v1_no_delete
BEFORE DELETE ON live_intake_orders_v1 BEGIN SELECT RAISE(ABORT,'live_intake_order_immutable'); END;
CREATE TRIGGER IF NOT EXISTS live_intake_orders_v1_conversion_immutable
BEFORE UPDATE ON live_intake_orders_v1
WHEN NEW.paper_order_ref != OLD.paper_order_ref OR NEW.trade_date != OLD.trade_date
  OR NEW.symbol != OLD.symbol OR NEW.side != OLD.side OR NEW.paper_shares != OLD.paper_shares
  OR NEW.live_shares != OLD.live_shares OR NEW.conversion_json != OLD.conversion_json
  OR NEW.conversion_sha256 != OLD.conversion_sha256 OR NEW.created_at != OLD.created_at
  OR (OLD.idempotency_key IS NOT NULL AND (NEW.idempotency_key IS NULL OR NEW.idempotency_key != OLD.idempotency_key))
  OR OLD.status IN ('SKIPPED','BLOCKED','RELAYED')
  OR (OLD.status = 'UNKNOWN' AND NEW.status NOT IN ('UNKNOWN','RELAYED','BLOCKED')
      AND NOT (NEW.status = 'DEFERRED' AND OLD.side = 'sell'))
BEGIN SELECT RAISE(ABORT,'live_intake_order_immutable'); END;

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
