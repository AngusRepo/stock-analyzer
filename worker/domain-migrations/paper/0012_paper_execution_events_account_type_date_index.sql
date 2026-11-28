-- daily-snapshot NAV reconciliation (paperSnapshotAudit.ts) looks up the previous dated-marks audit
-- and the window's share conversions by account + event type + trade date. With only
-- (account_id, created_at) to use, both walked every event row (account_id is always 1):
-- 2026-11-27 18:25 previousRow read 163,938 rows / 4.8 s plus TEMP B-TREE, conversions another
-- ~164K, and PAPER_DB returned "D1 DB is overloaded" on 11/26 and 11/27.
CREATE INDEX IF NOT EXISTS idx_paper_execution_events_account_type_date
  ON paper_execution_events(account_id, event_type, trade_date);
