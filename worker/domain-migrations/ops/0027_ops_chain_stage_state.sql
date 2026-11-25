-- Observability P2 (Grafana migration): one row per (business date, chain, stage) for the current
-- state, plus an append-only transition log. Written only on status changes (heartbeat: running
-- stages, at most once per 5 minutes, state table only). Contract shared with the monitoring Worker:
-- audits/grafana-obs-eval-20261124/p2p3_contract.md. Every read is a primary-key prefix range on
-- business_date; no other index on purpose (each index would double the row writes).
CREATE TABLE IF NOT EXISTS ops_chain_stage_state_v1 (
  business_date TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error','skipped','blocked')),
  optional INTEGER NOT NULL DEFAULT 0,
  expected_by TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  root_ticket_id TEXT,
  ticket_id TEXT,
  run_id TEXT,
  execution_name TEXT,
  summary TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (business_date, chain_id, stage_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ops_chain_stage_transitions_v1 (
  business_date TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  transition_at TEXT NOT NULL,
  to_status TEXT NOT NULL,
  from_status TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  ticket_id TEXT,
  run_id TEXT,
  summary TEXT,
  PRIMARY KEY (business_date, chain_id, stage_id, transition_at, to_status)
) WITHOUT ROWID;
