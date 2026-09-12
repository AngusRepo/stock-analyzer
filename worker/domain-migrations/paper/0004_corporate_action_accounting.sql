-- Accrued corporate rights are assets, not cash or sellable stock.
CREATE TABLE IF NOT EXISTS paper_corporate_entitlements_v1 (
  account_id INTEGER NOT NULL REFERENCES paper_accounts(id),
  action_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cash','stock','subscription')),
  ex_date TEXT NOT NULL,
  eligible_shares INTEGER NOT NULL CHECK(eligible_shares > 0),
  cash_due REAL NOT NULL DEFAULT 0 CHECK(cash_due >= 0),
  shares_due REAL NOT NULL DEFAULT 0 CHECK(shares_due >= 0),
  whole_shares_due INTEGER NOT NULL DEFAULT 0 CHECK(whole_shares_due >= 0),
  fractional_treatment TEXT CHECK(fractional_treatment IS NULL OR fractional_treatment='book_entry_fee'),
  cash_rounding TEXT CHECK(cash_rounding IS NULL OR cash_rounding='floor_twd'),
  share_cost_basis REAL NOT NULL DEFAULT 0 CHECK(share_cost_basis >= 0),
  position_basis_json TEXT,
  rights_json TEXT,
  payable_date TEXT,
  terms_json TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  recognized_at TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
  settled_at TEXT,
  PRIMARY KEY(account_id,action_id),
  CHECK((kind='cash' AND shares_due=0) OR (kind='stock' AND cash_due=0)
    OR (kind='subscription' AND cash_due=0 AND shares_due=0 AND rights_json IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_paper_corporate_outstanding
  ON paper_corporate_entitlements_v1(account_id,settled,payable_date);
CREATE TABLE IF NOT EXISTS paper_corporate_sessions_v1 (
  account_id INTEGER NOT NULL REFERENCES paper_accounts(id),
  session_date TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(account_id,session_date)
);
