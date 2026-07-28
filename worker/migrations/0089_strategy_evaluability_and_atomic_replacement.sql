-- Strategy evaluability and atomic paired replacement closure.
-- Existing pre-v5 decisions fail closed until point-in-time reconstruction proves their inputs.
ALTER TABLE strategy_decision_log ADD COLUMN evaluable INTEGER NOT NULL DEFAULT 0 CHECK(evaluable IN (0,1));
ALTER TABLE strategy_decision_log ADD COLUMN unavailable_reason TEXT;

ALTER TABLE strategy_learning_daily_stats ADD COLUMN evaluable_decisions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategy_learning_daily_stats ADD COLUMN unavailable_decisions INTEGER NOT NULL DEFAULT 0;

ALTER TABLE strategy_learning_head ADD COLUMN lifetime_evaluable_decisions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategy_learning_head ADD COLUMN lifetime_unavailable_decisions INTEGER NOT NULL DEFAULT 0;

UPDATE strategy_learning_daily_stats
   SET evaluable_decisions=0,
       unavailable_decisions=decisions,
       projection_version='strategy-learning-daily-v2',
       updated_at=CURRENT_TIMESTAMP;

UPDATE strategy_learning_head
   SET lifetime_evaluable_decisions=0,
       lifetime_unavailable_decisions=lifetime_decisions,
       projection_version='strategy-learning-head-v2',
       updated_at=CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_evaluability
  ON strategy_decision_log(date DESC, strategy_id, evaluable, matched);

CREATE TABLE IF NOT EXISTS strategy_evidence_rebuild_runs_v5 (
  signal_date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','success','blocked','failed')),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  strategy_count INTEGER NOT NULL DEFAULT 0,
  decision_rows INTEGER NOT NULL DEFAULT 0,
  evaluable_rows INTEGER NOT NULL DEFAULT 0,
  unavailable_rows INTEGER NOT NULL DEFAULT 0,
  matrix_rows INTEGER NOT NULL DEFAULT 0,
  labeler_version TEXT NOT NULL DEFAULT 'strategy-decision-log-pit-reconstruction-v5',
  source_checksum TEXT,
  blocker_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_strategy_evidence_rebuild_v5_status
  ON strategy_evidence_rebuild_runs_v5(status, signal_date);

CREATE TABLE IF NOT EXISTS strategy_replacement_decisions_v5 (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  family_id TEXT NOT NULL,
  candidate_strategy_id TEXT NOT NULL,
  candidate_strategy_version TEXT NOT NULL,
  replaced_strategy_id TEXT NOT NULL,
  replaced_strategy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected')),
  paired_dates INTEGER NOT NULL DEFAULT 0,
  paired_delta_mean REAL,
  paired_delta_lcb90 REAL,
  candidate_absolute_mean REAL,
  candidate_max_drawdown REAL,
  replaced_max_drawdown REAL,
  candidate_turnover REAL,
  replaced_turnover REAL,
  return_correlation REAL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, candidate_strategy_id, candidate_strategy_version, replaced_strategy_id, replaced_strategy_version),
  CHECK(json_valid(evidence_json))
);

CREATE INDEX IF NOT EXISTS idx_strategy_replacement_v5_asof
  ON strategy_replacement_decisions_v5(as_of_date DESC, status, family_id);

CREATE TABLE IF NOT EXISTS strategy_replacement_cutover_guards_v5 (
  guard_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('pre','post','portfolio_post')),
  precondition_ok INTEGER NOT NULL CHECK(precondition_ok=1),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(json_valid(evidence_json))
);

CREATE INDEX IF NOT EXISTS idx_strategy_replacement_cutover_guards_v5_run
  ON strategy_replacement_cutover_guards_v5(run_id, phase);

UPDATE strategy_spec_registry
   SET status='research',
       owner_type='observe',
       promotion_status='research',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id IN (
   'stock_tech_s05_first_dry_pullback_v1',
   'stock_tech_s07_2b_false_break_reversal_v1',
   'stock_tech_s09_three_soldiers_base_breakout_v1',
   'stock_tech_s10_island_reversal_v1'
 )
   AND status <> 'retired';

UPDATE strategy_spec_registry
   SET status='retired',
       owner_type='retired',
       promotion_status='retired',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id='stock_tech_s08_rsi2_bull_mean_reversion_v1';

INSERT OR IGNORE INTO strategy_spec_registry (
  strategy_id, version, name, status, owner, alpha_bucket, family_id, variant_id,
  owner_type, promotion_status, supported_regimes_json, thesis, thresholds_json,
  candidate_policy_json, risk_notes_json, source_refs_json, created_by, created_at, updated_at
)
SELECT
  'stock_tech_s08_rsi2_risk_filter_v1', 'strategy-spec-v1',
  'S8 RSI2 oversold risk filter', 'research', 'strategy', alpha_bucket, family_id,
  's08_inverse_filter', 'observe', 'research', supported_regimes_json,
  'Observe RSI2 oversold conditions as a risk/filter feature; no direct long production ownership.',
  '{"dsl":{"all":[{"signal":"technicalIndicators.stockTechS08RiskFilterSignal","op":">=","value":1}]}}',
  '{"poolQuota":0,"costBudget":0,"maxMlShare":0,"evidenceRequirements":["daily_adjusted_ohlcv","rsi2"]}',
  '["observe_only","inverse_proxy_is_not_a_tradable_short","requires_independent_oos_edge"]',
  source_refs_json, 'p5_strategy_governance', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM strategy_spec_registry
WHERE strategy_id='stock_tech_s08_rsi2_bull_mean_reversion_v1'
ORDER BY updated_at DESC
LIMIT 1;

UPDATE strategy_spec_registry
   SET status='retired',
       owner_type='retired',
       promotion_status='retired',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id='stock_tech_s12_multitimeframe_smc_reclaim_v1';

INSERT OR IGNORE INTO strategy_spec_registry (
  strategy_id, version, name, status, owner, alpha_bucket, family_id, variant_id,
  owner_type, promotion_status, supported_regimes_json, thesis, thresholds_json,
  candidate_policy_json, risk_notes_json, source_refs_json, created_by, created_at, updated_at
)
SELECT
  'stock_tech_s12_multitimeframe_smc_reclaim_v2', 'strategy-spec-v1', name, 'candidate', owner, alpha_bucket,
  'SMC_STRUCTURE_RECLAIM', 's12_formal_intraday_snapshot', 'strategy', 'candidate',
  supported_regimes_json,
  'Multi-timeframe SMC reclaim evaluated only from point-in-time formal intraday structure snapshots.',
  '{"dsl":{"all":[{"signal":"technicalIndicators.stockTechS12StructureAvailable","op":">=","value":1},{"signal":"technicalIndicators.stockTechS12Signal","op":">=","value":1}]}}',
  '{"evidenceRequirements":["s12_structure_snapshots","intraday_15m","intraday_60m"],"maxMlShare":0.15}',
  '["formal_intraday_owner_only","data_unavailable_excluded_from_promotion_denominator","no_daily_proxy"]',
  source_refs_json, 'p5_strategy_governance', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM strategy_spec_registry
WHERE strategy_id='stock_tech_s12_multitimeframe_smc_reclaim_v1'
ORDER BY updated_at DESC
LIMIT 1;
