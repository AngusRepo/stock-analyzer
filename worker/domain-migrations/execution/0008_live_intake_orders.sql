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
