UPDATE data_retention_policies
   SET dataset_pattern='price_horizon_labels_v2,canonical_selection_outcomes_v1,strategy_evidence_metrics_v1',
       updated_at=CURRENT_TIMESTAMP
 WHERE policy_id='strategy_multi_horizon_outcomes_v1';
