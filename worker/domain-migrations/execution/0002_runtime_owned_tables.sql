-- Add runtime-owned tables deferred from the immutable domain baseline.
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
