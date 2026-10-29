-- Live intake denominator (R33-NEW-37 §2, Wei 10/29 option A): the portfolio value each
-- auto_ml buy was sized against (sizingAuthorization.portfolioValue). Written once per buy,
-- after Paper's own writes; Paper never reads it and a failed write never blocks Paper.
-- 0012 is left for codex/a-monthly-p6a-20261020; the runner orders and records by name.
CREATE TABLE IF NOT EXISTS paper_order_sizing_v1 (
  order_id INTEGER PRIMARY KEY,
  portfolio_value REAL NOT NULL CHECK (portfolio_value > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A second insert for an order is a no-op, so INSERT OR REPLACE cannot rewrite a value either.
CREATE TRIGGER IF NOT EXISTS paper_order_sizing_v1_no_replace
BEFORE INSERT ON paper_order_sizing_v1
WHEN EXISTS (SELECT 1 FROM paper_order_sizing_v1 WHERE order_id = NEW.order_id)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS paper_order_sizing_v1_no_update
BEFORE UPDATE ON paper_order_sizing_v1
BEGIN
  SELECT RAISE(ABORT, 'paper_order_sizing_v1_append_only');
END;

CREATE TRIGGER IF NOT EXISTS paper_order_sizing_v1_no_delete
BEFORE DELETE ON paper_order_sizing_v1
BEGIN
  SELECT RAISE(ABORT, 'paper_order_sizing_v1_append_only');
END;
