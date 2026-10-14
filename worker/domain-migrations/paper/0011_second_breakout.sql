-- Versioned state + immutable per-qualified-bar evidence. No changes to legacy first-signal rows.
CREATE TABLE IF NOT EXISTS paper_second_breakout_state_v2 (
 account_id INTEGER NOT NULL, trade_date TEXT NOT NULL, symbol TEXT NOT NULL, policy TEXT NOT NULL,
 first_signal_ms INTEGER NOT NULL, evaluated_ms INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('unknown','weak_waiting','passed')),
 evidence_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(account_id,trade_date,symbol,policy)
);
CREATE TABLE IF NOT EXISTS paper_second_breakout_signals_v2 (
 account_id INTEGER NOT NULL, trade_date TEXT NOT NULL, symbol TEXT NOT NULL, policy TEXT NOT NULL,
 signal_ms INTEGER NOT NULL, evidence_json TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(account_id,trade_date,symbol,policy,signal_ms)
);
