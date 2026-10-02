-- Research receipts only: no foreign writes to formal Paper accounts or targets.
CREATE TABLE IF NOT EXISTS rfs_sparse_comparisons_v1 (
  plan_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK(schema_version='rfs-b-sparse-comparison-v1'),
  signal_date TEXT NOT NULL,
  policy_identity TEXT NOT NULL,
  allocation_snapshot_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  last_outcome_check_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('collecting','blocked')),
  packet_checksum TEXT NOT NULL CHECK(length(packet_checksum)=64),
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rfs_sparse_observed ON rfs_sparse_comparisons_v1(observed_at);
CREATE TABLE IF NOT EXISTS rfs_sparse_outcomes_v1 (
  plan_id TEXT NOT NULL REFERENCES rfs_sparse_comparisons_v1(plan_id),
  horizon INTEGER NOT NULL CHECK(horizon IN (5,20)),
  entry_date TEXT NOT NULL,
  exit_date TEXT NOT NULL,
  delta REAL NOT NULL,
  incumbent_net REAL NOT NULL,
  challenger_net REAL NOT NULL,
  known_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  PRIMARY KEY(plan_id,horizon)
);
