-- Learning D1 is a bounded online evidence store. Ten-year reproducibility
-- lives in checksum-verified cold artifacts; overlapping retain-only policies
-- are retired so one policy owns each hot-window lifecycle.
UPDATE data_retention_policies
   SET dataset_pattern='predictions,strategy_decision_log,replay,snapshots,selection_reference,strategy_labels,canonical_outcomes,price_horizon_labels',
       hot_retention_days=120,
       cold_retention_days=3650,
       archive_store='r2',
       action='archive_delete',
       hard_reference_protected=1,
       version=2,
       status='active',
       approved_reason='Keep a 120-day online Learning window (60 train sessions + purge/horizon/buffer); preserve ten-year checksum-verified cold lineage before any exact-key deletion',
       updated_at=CURRENT_TIMESTAMP
 WHERE policy_id='learning_lineage_v1';

UPDATE data_retention_policies
   SET status='retired',
       approved_reason='Superseded by learning_lineage_v1 v2 bounded-hot archive-delete ownership',
       updated_at=CURRENT_TIMESTAMP
 WHERE policy_id IN ('price_horizon_learning_v1','strategy_multi_horizon_outcomes_v1');
