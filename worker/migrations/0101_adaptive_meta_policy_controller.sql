-- Append-only decisions for the single-owner guarded Meta policy controller.
CREATE TABLE IF NOT EXISTS adaptive_meta_policy_decisions (
  decision_id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,
  candidate_policy_id TEXT,
  method TEXT,
  decision TEXT NOT NULL CHECK(decision IN (
    'reject','observe','promote_canary','promote_active','retain_canary','retain_active','rollback'
  )),
  reason TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('inactive','observing','canary','active','rolled_back')),
  consecutive_passes INTEGER NOT NULL DEFAULT 0,
  previous_policy_id TEXT,
  serving_policy_id TEXT,
  apply_status TEXT NOT NULL CHECK(apply_status IN ('pending_apply','applied','failed')),
  apply_error TEXT,
  failed_checks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(failed_checks_json)),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_adaptive_meta_policy_decisions_run
  ON adaptive_meta_policy_decisions(run_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adaptive_meta_policy_decisions_status
  ON adaptive_meta_policy_decisions(apply_status, phase, run_date DESC);
