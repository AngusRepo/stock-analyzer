-- Explicit paper-only portfolio and complete-account reward ownership.
CREATE TABLE IF NOT EXISTS l4_portfolio_plans_v1 (
  plan_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL CHECK(account_id=1),
  signal_date TEXT NOT NULL,
  policy_identity TEXT NOT NULL,
  activated INTEGER NOT NULL DEFAULT 0 CHECK(activated IN (0,1)),
  allocation_snapshot_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_l4_portfolio_plans_date ON l4_portfolio_plans_v1(account_id,signal_date);
CREATE TABLE IF NOT EXISTS l4_policy_account_rewards_v1 (
  receipt_id TEXT PRIMARY KEY,
  known_date TEXT NOT NULL,
  policy_identity TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS l4_replan_requests_v1 (
  request_id TEXT PRIMARY KEY,
  source_plan_id TEXT NOT NULL,
  result_plan_id TEXT,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS l4_portfolio_head_v1 (
  account_id INTEGER PRIMARY KEY CHECK(account_id=1),
  plan_id TEXT REFERENCES l4_portfolio_plans_v1(plan_id)
);
INSERT OR IGNORE INTO l4_portfolio_head_v1(account_id,plan_id) VALUES(1,NULL);
CREATE TABLE IF NOT EXISTS l4_replan_outbox_v1 (
  request_id TEXT PRIMARY KEY,
  source_plan_id TEXT NOT NULL REFERENCES l4_portfolio_plans_v1(plan_id),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired')),
  result_plan_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Legacy orders remain one intent per symbol/session. L4 revisions are deduplicated
-- by their primary key (plan + observed shares), with an atomic account-head guard.
DROP INDEX IF EXISTS idx_paper_order_intents_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_order_intents_unique
  ON paper_order_intents(account_id,trade_date,symbol,side,source)
  WHERE instr(intent_key,':l4:')=0;
