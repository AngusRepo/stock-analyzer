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
