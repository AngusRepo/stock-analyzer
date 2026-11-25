-- Stored market risk v2 (each factor group counted once). market_risk.risk_score keeps v1 semantics.
CREATE TABLE IF NOT EXISTS market_risk_stress_v2 (
  date TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK(schema_version='market-risk-stress-v2'),
  status TEXT NOT NULL CHECK(status IN ('complete','bounded','blocked')),
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  calibrated_score REAL NOT NULL CHECK(calibrated_score BETWEEN 0 AND 100),
  level TEXT NOT NULL CHECK(level IN ('green','yellow','orange','red','black')),
  quality_checksum TEXT NOT NULL CHECK(length(quality_checksum)=64),
  json TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum)=64),
  updated_at TEXT NOT NULL
);
