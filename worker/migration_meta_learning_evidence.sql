CREATE TABLE IF NOT EXISTS meta_reward_ledger (
  policy_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  context_hash TEXT NOT NULL DEFAULT 'global',
  samples INTEGER NOT NULL DEFAULT 0,
  reward_sum REAL NOT NULL DEFAULT 0,
  reward_mean REAL,
  last_reward_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence_json TEXT,
  PRIMARY KEY (policy_id, arm_id, context_hash)
);

CREATE INDEX IF NOT EXISTS idx_meta_reward_ledger_policy
  ON meta_reward_ledger(policy_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS meta_shadow_decisions (
  decision_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  business_date TEXT NOT NULL,
  symbol TEXT,
  arm_id TEXT,
  baseline_action TEXT,
  shadow_action TEXT,
  counterfactual_reward REAL,
  context_json TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meta_shadow_decisions_policy_date
  ON meta_shadow_decisions(policy_id, business_date DESC, created_at DESC);
