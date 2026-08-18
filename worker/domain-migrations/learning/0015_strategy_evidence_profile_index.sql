-- Bound nightly strategy evidence materialization by profile without full matrix scans.
CREATE INDEX IF NOT EXISTS idx_strategy_label_matrix_v4_profile_evidence
  ON strategy_label_matrix_v4(strategy_id, strategy_version, strategy_hit, evaluable);
