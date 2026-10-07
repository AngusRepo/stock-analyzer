-- P9 account/session authority. Atomic SQL updates preserve peak and halt monotonically.
CREATE TABLE IF NOT EXISTS paper_intraday_nav_risk_v1 (
 account_id INTEGER NOT NULL CHECK(account_id>0), trade_date TEXT NOT NULL,
 peak_nav REAL NOT NULL CHECK(peak_nav>0), last_nav REAL NOT NULL CHECK(last_nav>0),
 halted INTEGER NOT NULL CHECK(halted IN (0,1)), updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,trade_date)
);
