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
