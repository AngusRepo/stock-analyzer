-- Durable S12 structure computation and intraday formal-EV continuation.
-- Large payloads remain immutable R2 artifacts; D1 stores scalar lineage and
-- retryable run/shard state only.

CREATE TABLE IF NOT EXISTS s12_structure_batch_runs (
  run_id TEXT PRIMARY KEY,
  trade_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('evening_chain','historical_shadow','manual_repair')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  shard_count INTEGER NOT NULL DEFAULT 0,
  completed_shards INTEGER NOT NULL DEFAULT 0,
  artifact_id TEXT,
  artifact_checksum TEXT,
  last_error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(artifact_checksum IS NULL OR artifact_checksum GLOB 'sha256:[0-9a-f]*')
);
CREATE INDEX IF NOT EXISTS idx_s12_structure_batch_runs_date_status
  ON s12_structure_batch_runs(trade_date DESC, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS s12_structure_batch_shards (
  run_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  first_symbol TEXT,
  last_symbol TEXT,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','running','success','error')),
  attempt INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  setup_waiting_count INTEGER NOT NULL DEFAULT 0,
  risk_blocked_count INTEGER NOT NULL DEFAULT 0,
  invalidated_count INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(run_id, shard_index),
  FOREIGN KEY(run_id) REFERENCES s12_structure_batch_runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_s12_structure_batch_shards_status
  ON s12_structure_batch_shards(status, updated_at, run_id, shard_index);

CREATE TABLE IF NOT EXISTS s12_formal_ev_decisions (
  decision_id TEXT PRIMARY KEY,
  observation_date TEXT NOT NULL,
  source_trade_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  structure_snapshot_id INTEGER,
  structure_state TEXT NOT NULL,
  structure_class TEXT NOT NULL CHECK(structure_class IN (
    'execution_ready','setup_waiting','risk_blocked','invalidated','unavailable'
  )),
  s12_ev_status TEXT NOT NULL,
  expected_return_owner TEXT,
  expected_return REAL,
  uncertainty_adjusted_expected_return REAL,
  action TEXT NOT NULL CHECK(action IN ('potential_buy','hold','abstain')),
  reason_code TEXT NOT NULL,
  l4_model_version TEXT,
  fusion_model_version TEXT,
  s12_artifact_id TEXT,
  producer_run_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(observation_date, source_trade_date, symbol, producer_run_id),
  CHECK(json_valid(evidence_json))
);
CREATE INDEX IF NOT EXISTS idx_s12_formal_ev_decisions_current
  ON s12_formal_ev_decisions(observation_date DESC, action, source_trade_date DESC, symbol);
CREATE INDEX IF NOT EXISTS idx_s12_formal_ev_decisions_symbol
  ON s12_formal_ev_decisions(symbol, observation_date DESC, created_at DESC);
