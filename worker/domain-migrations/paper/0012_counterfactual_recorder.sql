-- Research-only single-signal lots. No foreign writes to accounts, orders or positions.
CREATE TABLE IF NOT EXISTS paper_counterfactual_lots_v1 (
 account_id INTEGER NOT NULL, lot_id TEXT NOT NULL, symbol TEXT NOT NULL,
 signal_ms INTEGER NOT NULL, version INTEGER NOT NULL, state_sha TEXT NOT NULL,
 state_json TEXT NOT NULL, open_arms INTEGER NOT NULL, observed_ms INTEGER NOT NULL,
 PRIMARY KEY (account_id,lot_id)
);
CREATE INDEX IF NOT EXISTS idx_counterfactual_open_v1 ON paper_counterfactual_lots_v1(account_id,open_arms,observed_ms);
CREATE TABLE IF NOT EXISTS paper_counterfactual_events_v1 (
 account_id INTEGER NOT NULL, lot_id TEXT NOT NULL, version INTEGER NOT NULL,
 observed_ms INTEGER NOT NULL, previous_sha TEXT, state_sha TEXT NOT NULL,
 evidence_sha TEXT NOT NULL, evidence_json TEXT NOT NULL,
 PRIMARY KEY(account_id,lot_id,version)
);
CREATE TABLE IF NOT EXISTS paper_counterfactual_signals_v1 (
 account_id INTEGER NOT NULL, lot_id TEXT NOT NULL, observed_ms INTEGER NOT NULL,
 reason TEXT NOT NULL, evidence_sha TEXT NOT NULL, evidence_json TEXT NOT NULL,
 PRIMARY KEY(account_id,lot_id,observed_ms)
);
