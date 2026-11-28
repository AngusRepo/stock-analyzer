-- L4 OPB v3 full-information arm replay ledger (session pieces). Research
-- evidence only: the formal plan reads it (known_date <= signal_date) to choose
-- an arm; it never writes Paper accounts or targets. Additive; insert-or-verify.
--
-- One row per (context, signal day, arm, session of the five-session hold). The
-- pieces of one (signal day, arm) sum to the five-session net label (entry open
-- -> exit close; entry/rebalance cost on session 1). delta is exposure
-- normalized: arm_piece * base_exposure / arm_exposure - base_piece.
-- market_piece is the 0050 piece of the same session (selection nets out beta).
-- row_kind: live_context (the day's own frozen context), counterfactual_inert
-- (a risk-halted day replayed at the policy's reference exposure), or
-- cutover_warm_start (a pre-cutover day replayed with the new L3's fold-OOF
-- scores). Selection admits the latter two only under their own KV switches.
-- status solve_failed: the allocator could not certify that challenger arm on that
-- day (base and the live plan's chosen arm never book it); terminal, never evidence.
CREATE TABLE IF NOT EXISTS l4_opb_arm_replay_v2 (
  context_identity TEXT NOT NULL CHECK(length(context_identity)=64),
  signal_date TEXT NOT NULL,
  arm_digest TEXT NOT NULL CHECK(length(arm_digest)=64),
  session_offset INTEGER NOT NULL CHECK(session_offset BETWEEN 1 AND 5),
  arm_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK(schema_version='l4-opb-arm-replay-v2'),
  reward_semantic TEXT NOT NULL CHECK(reward_semantic='exposure_normalized_market_neutral_daily_v1'),
  row_kind TEXT NOT NULL CHECK(row_kind IN ('live_context','counterfactual_inert','cutover_warm_start')),
  status TEXT NOT NULL CHECK(status IN ('complete','no_exposure','inert','solve_failed')),
  known_date TEXT NOT NULL CHECK(known_date>signal_date),
  arm_piece REAL NOT NULL,
  base_piece REAL NOT NULL,
  market_piece REAL NOT NULL,
  arm_exposure REAL NOT NULL CHECK(arm_exposure>=0),
  base_exposure REAL NOT NULL CHECK(base_exposure>=0),
  delta REAL NOT NULL,
  effective_digest TEXT NOT NULL CHECK(length(effective_digest)=64),
  weights_json TEXT NOT NULL,
  current_json TEXT NOT NULL,
  score_source TEXT NOT NULL CHECK(score_source IN ('serving','fold_oof')),
  snapshot_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  replay_plan_id TEXT NOT NULL,
  consistency TEXT NOT NULL,
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum)=64),
  materialized_at TEXT NOT NULL,
  PRIMARY KEY(context_identity, signal_date, arm_digest, session_offset)
);
CREATE INDEX IF NOT EXISTS idx_l4_opb_arm_replay_v2_known
  ON l4_opb_arm_replay_v2(context_identity, known_date);
CREATE TRIGGER IF NOT EXISTS l4_opb_arm_replay_v2_no_update
BEFORE UPDATE ON l4_opb_arm_replay_v2
BEGIN SELECT RAISE(ABORT,'l4_opb_arm_replay_v2_immutable'); END;

-- Terminal verdicts of live replay days, one per (context, signal day): days the
-- ledger can never book in this context (no formal plan, L3 changed, frozen after
-- entry, risk lookback changed, empty pool) and days rejected because the plan's
-- decision-input digest does not match its frozen snapshot. The nightly replay
-- then skips the day with one primary-key read instead of re-reading the plan and
-- snapshot every night; a rejection stays queryable here and is reported on every
-- run (rejected_dates). A new context (policy, L3 or allocator source change)
-- re-judges the day. Insert-or-verify; never updated.
CREATE TABLE IF NOT EXISTS l4_opb_arm_replay_verdicts_v1 (
  context_identity TEXT NOT NULL CHECK(length(context_identity)=64),
  signal_date TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK(schema_version='l4-opb-arm-replay-verdict-v1'),
  status TEXT NOT NULL CHECK(status IN ('no_formal_plan','not_applicable','rejected')),
  reason TEXT NOT NULL,
  snapshot_id TEXT,
  plan_id TEXT,
  detail_json TEXT NOT NULL,
  payload_checksum TEXT NOT NULL CHECK(length(payload_checksum)=64),
  materialized_at TEXT NOT NULL,
  PRIMARY KEY(context_identity, signal_date)
);
CREATE TRIGGER IF NOT EXISTS l4_opb_arm_replay_verdicts_v1_no_update
BEFORE UPDATE ON l4_opb_arm_replay_verdicts_v1
BEGIN SELECT RAISE(ABORT,'l4_opb_arm_replay_verdicts_v1_immutable'); END;

-- Run receipts of the independent replay job (OOF materialize job, mode
-- opb_arm_replay), one per execution. The Worker's active8-oof-daily task starts
-- the job and returns; its next tick reads the newest receipt of the business date
-- to mark the night complete or start another execution. Never updated.
CREATE TABLE IF NOT EXISTS l4_opb_arm_replay_runs_v1 (
  business_date TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK(schema_version='l4-opb-arm-replay-run-v1'),
  status TEXT NOT NULL CHECK(status IN ('ok','failed','skipped')),
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  -- Ledger rows written plus verdicts recorded; 0 ends the night (see run_complete).
  progress INTEGER NOT NULL CHECK(progress>=0),
  failed_dates_json TEXT NOT NULL,
  deferred_dates_json TEXT NOT NULL,
  rejected_dates_json TEXT NOT NULL,
  missing_price_dates_json TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY(business_date, execution_id)
);
CREATE INDEX IF NOT EXISTS idx_l4_opb_arm_replay_runs_v1_finished
  ON l4_opb_arm_replay_runs_v1(business_date, finished_at);
CREATE TRIGGER IF NOT EXISTS l4_opb_arm_replay_runs_v1_no_update
BEFORE UPDATE ON l4_opb_arm_replay_runs_v1
BEGIN SELECT RAISE(ABORT,'l4_opb_arm_replay_runs_v1_immutable'); END;

-- Work queue of the v3 nightly replay: days of one context that could not be booked
-- (a held name without prices, a failure). The replay tries them after every other
-- day, least recently tried first, so they cannot take the per-run budget every night
-- and starve older days. Ordering only, never evidence; rows are deleted once the day
-- books, is judged, or leaves the window. Read with the primary-key prefix.
CREATE TABLE IF NOT EXISTS l4_opb_arm_replay_retry_v1 (
  context_identity TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('missing_price','failed')),
  detail_json TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts>=1),
  last_attempt_at TEXT NOT NULL,
  PRIMARY KEY(context_identity, signal_date)
);
-- Age prune of rows left by older contexts (never read again): DELETE ... WHERE last_attempt_at<?.
CREATE INDEX IF NOT EXISTS idx_l4_opb_arm_replay_retry_v1_attempt
  ON l4_opb_arm_replay_retry_v1(last_attempt_at);
