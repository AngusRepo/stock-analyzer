-- Local candidate only. Apply as part of the explicitly approved policy release.
CREATE TABLE IF NOT EXISTS paper_daily_plan_reviews_v1 (
 account_id INTEGER NOT NULL, trade_date TEXT NOT NULL, checksum TEXT NOT NULL,
 plan_id TEXT NOT NULL, previous_hash TEXT, revision INTEGER NOT NULL CHECK(revision>=0),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(account_id,trade_date,checksum)
);
CREATE TABLE IF NOT EXISTS paper_daily_plan_heads_v1 (
 account_id INTEGER NOT NULL, trade_date TEXT NOT NULL, checksum TEXT NOT NULL, plan_id TEXT NOT NULL,
 PRIMARY KEY(account_id,trade_date),
 FOREIGN KEY(account_id,trade_date,checksum) REFERENCES paper_daily_plan_reviews_v1(account_id,trade_date,checksum)
);
