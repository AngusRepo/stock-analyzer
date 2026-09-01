ALTER TABLE strategy_learning_runs
  ADD COLUMN production_authority_intent INTEGER NOT NULL DEFAULT 0
  CHECK(production_authority_intent IN (0, 1));

ALTER TABLE strategy_learning_runs
  ADD COLUMN policy_closure_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(policy_closure_status IN ('pending', 'materialized', 'evidence_only'));

ALTER TABLE strategy_learning_runs
  ADD COLUMN policy_closure_reason TEXT;

ALTER TABLE strategy_learning_runs
  ADD COLUMN policy_closure_completed_at TEXT;

UPDATE strategy_learning_runs
   SET production_authority_intent=0,
       policy_closure_status='evidence_only',
       policy_closure_reason='legacy_success_backfill_no_durable_policy_closure',
       policy_closure_completed_at=COALESCE(completed_at, updated_at)
 WHERE status='success'
   AND policy_closure_status='pending';

CREATE INDEX IF NOT EXISTS idx_strategy_learning_runs_policy_closure
  ON strategy_learning_runs(
    business_date DESC,
    production_authority_intent,
    policy_closure_status
  );

CREATE TABLE IF NOT EXISTS pit_residual_funnel_enrichment_runs_v1 (
  business_date TEXT NOT NULL,
  screener_run_id TEXT NOT NULL,
  pipeline_canonical_run_id TEXT NOT NULL,
  source_signal_date TEXT,
  base_stage TEXT,
  base_candidate_count INTEGER NOT NULL DEFAULT 0,
  residual_item_count INTEGER NOT NULL DEFAULT 0,
  decision_effect TEXT NOT NULL DEFAULT 'none' CHECK(decision_effect = 'none'),
  status TEXT NOT NULL CHECK(status IN ('success', 'error')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  PRIMARY KEY(business_date, screener_run_id)
);

CREATE INDEX IF NOT EXISTS idx_pit_residual_funnel_enrichment_latest
  ON pit_residual_funnel_enrichment_runs_v1(business_date DESC, status, updated_at DESC);
