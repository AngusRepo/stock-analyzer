-- ─── P2#16: Weekly AI Audit Reports ──────────────────────────────────────────
-- 執行：wrangler d1 execute stockvision-db --remote --file=./worker/migration_weekly_audit.sql

CREATE TABLE IF NOT EXISTS weekly_audit_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date   TEXT NOT NULL UNIQUE,
  report_text   TEXT NOT NULL,              -- Human-readable markdown report
  l1_json       TEXT,                       -- L1 trade performance data
  l2_json       TEXT,                       -- L2 decision attribution data
  l3_json       TEXT,                       -- L3 model health data
  risk_json     TEXT,                       -- MC + PBO risk assessment
  created_at    TEXT DEFAULT (datetime('now'))
);
