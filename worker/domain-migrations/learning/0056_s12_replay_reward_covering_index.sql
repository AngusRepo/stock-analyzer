-- Compact eligible-replay index: evaluate large JSON predicates on writes, not every reward read.
-- The reward SELECT and its cost/eligibility/known-at rules are unchanged.
CREATE INDEX IF NOT EXISTS idx_s12_replay_reward_evidence_v1
ON s12_replay_trade_outcomes (
  json_extract(detail_json, '$.replay_diagnostics.replay_engine_signature'),
  signal_date,
  pnl_pct,
  date(json_extract(detail_json, '$.replay_diagnostics.outcome_known_date'))
)
WHERE signal_date IS NOT NULL
  AND sample_eligible=1
  AND source='s12_multisession_structure_replay_v3'
  AND pnl_pct IS NOT NULL
  AND json_extract(detail_json, '$.schema_version')='s12-replay-trade-outcome-v3'
  AND json_extract(detail_json, '$.observation_kind')='executed';
