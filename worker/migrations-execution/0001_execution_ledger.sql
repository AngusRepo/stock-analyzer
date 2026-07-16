-- Dedicated real-trading execution ledger.
-- Apply only to stockvision-execution-db; never apply to CORE_DB.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS execution_database_identity (
  identity_key TEXT PRIMARY KEY CHECK(identity_key='primary'),
  purpose TEXT NOT NULL CHECK(purpose='real_trading_execution_only'),
  schema_version TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO execution_database_identity (identity_key,purpose,schema_version,instance_id)
VALUES ('primary','real_trading_execution_only','stockvision-execution-ledger-v1','UNPROVISIONED')
ON CONFLICT(identity_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS broker_execution_intents (
  intent_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy','sell')),
  status TEXT NOT NULL CHECK(status IN (
    'RESERVED','REVALIDATED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED',
    'FILLED','CANCELLED','REJECTED','UNKNOWN','BLOCKED'
  )),
  packet_hash TEXT NOT NULL,
  approval_scope TEXT NOT NULL,
  requested_shares INTEGER NOT NULL CHECK(requested_shares > 0),
  limit_price REAL NOT NULL CHECK(limit_price > 0),
  intent_json TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  archive_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(archive_status IN ('pending','archived','failed')),
  archive_object_key TEXT,
  archive_sha256 TEXT,
  archive_attempts INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_broker_intents_trade_side
  ON broker_execution_intents(trade_date, side, status);
CREATE INDEX IF NOT EXISTS idx_broker_intents_symbol
  ON broker_execution_intents(trade_date, symbol, side);
CREATE INDEX IF NOT EXISTS idx_broker_intents_archive
  ON broker_execution_intents(archive_status, created_at);

CREATE TABLE IF NOT EXISTS broker_execution_legs (
  leg_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES broker_execution_intents(intent_id),
  leg_key TEXT NOT NULL,
  client_tag TEXT NOT NULL UNIQUE,
  lot_type TEXT NOT NULL CHECK(lot_type IN ('board_lot','odd_lot')),
  requested_shares INTEGER NOT NULL CHECK(requested_shares > 0),
  broker_quantity INTEGER NOT NULL CHECK(broker_quantity > 0),
  status TEXT NOT NULL CHECK(status IN (
    'RESERVED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED',
    'CANCELLED','REJECTED','UNKNOWN'
  )),
  broker_order_id TEXT,
  submit_attempts INTEGER NOT NULL DEFAULT 0 CHECK(submit_attempts >= 0),
  filled_shares INTEGER NOT NULL DEFAULT 0 CHECK(filled_shares >= 0),
  average_fill_price REAL,
  last_error TEXT,
  claimed_at TEXT,
  acknowledged_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(intent_id, leg_key),
  UNIQUE(broker_order_id),
  CHECK(filled_shares <= requested_shares)
);

CREATE INDEX IF NOT EXISTS idx_broker_legs_recovery
  ON broker_execution_legs(status, updated_at);

CREATE TABLE IF NOT EXISTS broker_execution_events (
  event_id TEXT PRIMARY KEY,
  intent_id TEXT,
  leg_id TEXT,
  broker_order_id TEXT,
  client_tag TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'INTENT_RESERVED','LEG_CLAIMED','SUBMIT_ACK','SUBMIT_UNKNOWN','SUBMIT_REJECTED',
    'ORDER_CALLBACK','DEAL_CALLBACK','STATUS_RECONCILIATION','CONNECTION_STATE','RECOVERY'
  )),
  event_status TEXT NOT NULL CHECK(event_status IN ('received','applied')),
  event_time TEXT NOT NULL,
  exchange_sequence TEXT,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  archive_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(archive_status IN ('pending','archived','failed')),
  archive_object_key TEXT,
  archive_sha256 TEXT,
  archive_attempts INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(intent_id) REFERENCES broker_execution_intents(intent_id),
  FOREIGN KEY(leg_id) REFERENCES broker_execution_legs(leg_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_events_order_time
  ON broker_execution_events(broker_order_id, event_time);
CREATE INDEX IF NOT EXISTS idx_broker_events_client_tag
  ON broker_execution_events(client_tag, event_time);
CREATE INDEX IF NOT EXISTS idx_broker_events_unmatched
  ON broker_execution_events(event_status, broker_order_id, leg_id);
CREATE INDEX IF NOT EXISTS idx_broker_events_archive
  ON broker_execution_events(archive_status, received_at);

CREATE TABLE IF NOT EXISTS execution_control_state (
  control_key TEXT PRIMARY KEY CHECK(control_key IN ('live_trading')),
  kill_switch_active INTEGER NOT NULL CHECK(kill_switch_active IN (0,1)),
  version INTEGER NOT NULL CHECK(version > 0),
  reason TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO execution_control_state
  (control_key,kill_switch_active,version,reason,updated_by)
VALUES ('live_trading',1,1,'initial_fail_closed','migration')
ON CONFLICT(control_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS execution_risk_decisions (
  decision_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES broker_execution_intents(intent_id),
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  risk_config_hash TEXT NOT NULL,
  broker_truth_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS execution_reconciliation_runs (
  reconciliation_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','passed','discrepancy','failed')),
  broker_account_hash TEXT,
  unresolved_leg_count INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_leg_count >= 0),
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS execution_reconciliation_discrepancies (
  discrepancy_id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES execution_reconciliation_runs(reconciliation_id),
  intent_id TEXT REFERENCES broker_execution_intents(intent_id),
  leg_id TEXT REFERENCES broker_execution_legs(leg_id),
  discrepancy_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_discrepancies_open
  ON execution_reconciliation_discrepancies(status, severity, created_at);
