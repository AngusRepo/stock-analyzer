-- Immutable first qualifying signal per account/session/symbol, independent of plan revisions.
CREATE TABLE IF NOT EXISTS paper_atr_once_v1 (
 account_id INTEGER NOT NULL, trade_date TEXT NOT NULL, symbol TEXT NOT NULL, policy TEXT NOT NULL,
 first_signal_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('unknown','passed','veto')),
 evidence_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(account_id,trade_date,symbol,policy)
);
