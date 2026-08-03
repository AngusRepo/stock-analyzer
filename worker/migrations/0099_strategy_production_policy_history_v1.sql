CREATE TABLE IF NOT EXISTS strategy_production_policy_history_v1 (
  policy_id TEXT NOT NULL,
  knowledge_cutoff_date TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active')),
  strategy_weights_json TEXT NOT NULL,
  quarantined_strategy_ids_json TEXT NOT NULL DEFAULT '[]',
  candidate_ready_strategy_ids_json TEXT NOT NULL DEFAULT '[]',
  base_weight_source TEXT NOT NULL,
  base_weight_run_id TEXT,
  evidence_json TEXT NOT NULL,
  canonical_payload TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(policy_id, knowledge_cutoff_date, checksum)
);

CREATE INDEX IF NOT EXISTS idx_strategy_production_policy_history_v1_cutoff
  ON strategy_production_policy_history_v1(policy_id, status, knowledge_cutoff_date DESC, created_at DESC);
