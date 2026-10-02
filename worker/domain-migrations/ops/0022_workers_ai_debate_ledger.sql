-- Completed charges are separate from unresolved reservations. Legacy values
-- remain a hold until an operator reconciles them against per-call receipts.
CREATE TABLE IF NOT EXISTS workers_ai_debate_days_v2 (
 account_id TEXT NOT NULL, utc_day TEXT NOT NULL,
 observed_neurons REAL NOT NULL CHECK(observed_neurons>=0),
 baseline_neurons REAL NOT NULL CHECK(baseline_neurons>=0),
 imported_completed INTEGER NOT NULL DEFAULT 0 CHECK(imported_completed>=0),
 legacy_hold INTEGER NOT NULL DEFAULT 0 CHECK(legacy_hold>=0),
 reconciliation_receipt TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,utc_day)
);
CREATE TABLE IF NOT EXISTS workers_ai_debate_calls_v2 (
 request_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, utc_day TEXT NOT NULL,
 bound_neurons INTEGER NOT NULL CHECK(bound_neurons>0),
 measured_neurons INTEGER CHECK(measured_neurons>0),
 created_at TEXT NOT NULL, completed_at TEXT,
 FOREIGN KEY(account_id,utc_day) REFERENCES workers_ai_debate_days_v2(account_id,utc_day)
);
CREATE INDEX IF NOT EXISTS workers_ai_debate_calls_day_v2
 ON workers_ai_debate_calls_v2(account_id,utc_day);
CREATE VIEW IF NOT EXISTS workers_ai_debate_balances_v2 AS
 SELECT d.*, COALESCE(SUM(c.measured_neurons),0)+d.imported_completed AS completed_neurons,
 COALESCE(SUM(CASE WHEN c.measured_neurons IS NULL THEN c.bound_neurons ELSE 0 END),0)+d.legacy_hold AS reserved_neurons,
 MAX(d.observed_neurons,d.baseline_neurons+d.imported_completed+COALESCE(SUM(c.measured_neurons),0))
 +d.legacy_hold+COALESCE(SUM(CASE WHEN c.measured_neurons IS NULL THEN c.bound_neurons ELSE 0 END),0) AS conservative_neurons
 FROM workers_ai_debate_days_v2 d LEFT JOIN workers_ai_debate_calls_v2 c
 ON c.account_id=d.account_id AND c.utc_day=d.utc_day GROUP BY d.account_id,d.utc_day;
