-- L4 OPB v2 full-information arm replay ledger. Research evidence only: the
-- formal plan reads it (known_date <= signal_date) to choose an arm; it never
-- writes Paper accounts or targets. Additive; rows are insert-or-verify.
CREATE TABLE IF NOT EXISTS l4_opb_arm_replay_v1 (
  context_identity TEXT NOT NULL CHECK(length(context_identity)=64),
  signal_date TEXT NOT NULL,
  arm_digest TEXT NOT NULL CHECK(length(arm_digest)=64),
  arm_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK(schema_version='l4-opb-arm-replay-v1'),
  known_date TEXT NOT NULL CHECK(known_date>signal_date),
  arm_return REAL NOT NULL,
  base_return REAL NOT NULL,
  delta REAL NOT NULL,
  effective_digest TEXT NOT NULL CHECK(length(effective_digest)=64),
  arm_inert INTEGER NOT NULL CHECK(arm_inert IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('complete','arm_inert')),
  snapshot_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  replay_plan_id TEXT NOT NULL,
  consistency TEXT NOT NULL,
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum)=64),
  materialized_at TEXT NOT NULL,
  PRIMARY KEY(context_identity, signal_date, arm_digest)
);
CREATE INDEX IF NOT EXISTS idx_l4_opb_arm_replay_known
  ON l4_opb_arm_replay_v1(context_identity, known_date);
CREATE TRIGGER IF NOT EXISTS l4_opb_arm_replay_no_update_v1
BEFORE UPDATE ON l4_opb_arm_replay_v1
BEGIN SELECT RAISE(ABORT,'l4_opb_arm_replay_immutable'); END;
