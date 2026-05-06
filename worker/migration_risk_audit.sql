-- ─── #20/#26 R3 risk_audit_log ────────────────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_risk_audit.sql
--
-- 4-level risk framework audit trail. Every buy/sell/halt decision writes
-- one row here with full AggregatedRiskState + OrderValidation snapshots.
--
-- Retention: 90 days hot. Weekly cron prunes older rows.

CREATE TABLE IF NOT EXISTS risk_audit_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp             TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_event         TEXT NOT NULL,        -- 'morning_setup' | 'intraday_buy' | 'intraday_exit' | 'eod_exit' | 'kill_switch' | 'force_day_trade_close'
  account_id            INTEGER NOT NULL DEFAULT 1,
  symbol                TEXT,                 -- null for portfolio-only events
  side                  TEXT,                 -- 'buy' | 'sell' | null
  decision              TEXT NOT NULL,        -- 'executed' | 'blocked' | 'adjusted' | 'deferred' | 'halt'
  halt                  INTEGER NOT NULL DEFAULT 0,
  triggered_count       INTEGER NOT NULL DEFAULT 0,
  severity              TEXT NOT NULL DEFAULT 'normal',  -- 'normal' | 'elevated' | 'high' | 'critical' | 'halted'
  max_position_pct      REAL,
  buy_conf_threshold    REAL,
  sell_conf_threshold   REAL,
  risk_state_json       TEXT NOT NULL,        -- full AggregatedRiskState (includes triggered layer list + reasons)
  order_validation_json TEXT,                 -- OrderValidation when trigger is order-related
  config_version        TEXT,                 -- trading:risk_config hash or timestamp
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_audit_ts       ON risk_audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_risk_audit_halt     ON risk_audit_log(halt, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_risk_audit_sev      ON risk_audit_log(severity, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_risk_audit_trigger  ON risk_audit_log(trigger_event, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_risk_audit_symbol   ON risk_audit_log(symbol, timestamp DESC);
