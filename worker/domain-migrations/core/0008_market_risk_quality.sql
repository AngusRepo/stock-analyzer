CREATE TABLE IF NOT EXISTS market_risk_quality_v1 (
  date TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK(schema_version='market-risk-quality-v1'),
  status TEXT NOT NULL CHECK(status IN ('complete','bounded','blocked')),
  known_score REAL NOT NULL CHECK(known_score BETWEEN 0 AND 100),
  upper_score REAL NOT NULL CHECK(upper_score BETWEEN known_score AND 100),
  json TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum)=64),
  updated_at TEXT NOT NULL
);
