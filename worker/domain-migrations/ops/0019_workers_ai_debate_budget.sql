-- One small row per account/UTC day; no Learning payload growth.
-- Failed/ambiguous attempts keep their reservation; never refund speculatively.
CREATE TABLE IF NOT EXISTS workers_ai_debate_budget_v1 (
  account_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  observed_neurons REAL NOT NULL CHECK(observed_neurons>=0),
  reserved_neurons INTEGER NOT NULL CHECK(reserved_neurons>=0),
  updated_at TEXT NOT NULL,
  last_request_neurons INTEGER NOT NULL CHECK(last_request_neurons>=0),
  last_request_admitted INTEGER NOT NULL CHECK(last_request_admitted IN (0,1)),
  PRIMARY KEY(account_id,utc_day)
);
