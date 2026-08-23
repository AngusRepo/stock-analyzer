-- Consolidate evidence-session legality, expected-return owner state, and the
-- strategy evidence read model without duplicating raw observations.

CREATE TABLE IF NOT EXISTS expected_return_owner_state_v2 (
  owner TEXT PRIMARY KEY CHECK(owner IN ('l4_alpha_ev','allocator_ev_fusion')),
  owner_state TEXT NOT NULL CHECK(owner_state IN ('learned_champion','safe_abstention','no_champion')),
  champion_artifact_id TEXT,
  reason_code TEXT NOT NULL,
  contract_manifest_version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (owner_state='learned_champion' AND champion_artifact_id IS NOT NULL)
    OR (owner_state!='learned_champion' AND champion_artifact_id IS NULL)
  )
);

INSERT INTO expected_return_owner_state_v2 (
  owner, owner_state, champion_artifact_id, reason_code,
  contract_manifest_version, updated_at
)
WITH owners(owner) AS (
  VALUES ('l4_alpha_ev'), ('allocator_ev_fusion')
)
SELECT
  owners.owner,
  CASE
    WHEN x.serving_mode='alpha' AND p.champion_artifact_id IS NOT NULL THEN 'learned_champion'
    WHEN x.serving_mode='abstention_baseline' THEN 'safe_abstention'
    ELSE 'no_champion'
  END,
  CASE WHEN x.serving_mode='alpha' THEN p.champion_artifact_id ELSE NULL END,
  CASE
    WHEN x.serving_mode='alpha' THEN 'learned_champion_pointer_active'
    WHEN x.serving_mode='abstention_baseline' THEN 'deprecated_baseline_pointer_ignored'
    ELSE 'no_current_contract_champion'
  END,
  'expected-return-contract-manifest-v1',
  CURRENT_TIMESTAMP
FROM owners
LEFT JOIN model_champion_pointers p ON p.model_name=owners.owner
LEFT JOIN expected_return_artifact_payloads x ON x.artifact_id=p.champion_artifact_id
ON CONFLICT(owner) DO UPDATE SET
  owner_state=excluded.owner_state,
  champion_artifact_id=excluded.champion_artifact_id,
  reason_code=excluded.reason_code,
  contract_manifest_version=excluded.contract_manifest_version,
  updated_at=CURRENT_TIMESTAMP;

DROP VIEW IF EXISTS evidence_session_eligibility_v1;
CREATE VIEW evidence_session_eligibility_v1 AS
SELECT
  prediction_date AS session_date,
  evidence_scope,
  cohort_id AS lineage_id,
  eligibility_status,
  reason_code,
  evidence_schema_version AS contract_version,
  assessed_knowledge_cutoff AS knowledge_cutoff,
  1 AS sample_count,
  'active8_oof_date_eligibility' AS source_table
FROM active8_oof_date_eligibility
UNION ALL
SELECT
  signal_date AS session_date,
  'strategy_route_l1_5' AS evidence_scope,
  producer_run_id AS lineage_id,
  CASE status WHEN 'eligible' THEN 'legal' WHEN 'unavailable' THEN 'illegal' ELSE 'pending' END,
  CASE
    WHEN status='eligible' THEN 'route_contract_complete'
    WHEN status='pending_maturity' THEN 'route_outcome_pending_maturity'
    ELSE COALESCE(json_extract(blocker_json, '$[0]'), 'route_contract_unavailable')
  END,
  'strategy-route-backfill-eligibility-v1' AS contract_version,
  audited_as_of_date AS knowledge_cutoff,
  mature_label_rows AS sample_count,
  'strategy_route_backfill_eligibility_v1' AS source_table
FROM strategy_route_backfill_eligibility_v1
UNION ALL
SELECT
  signal_date AS session_date,
  'strategy_multi_horizon_' || horizon_days AS evidence_scope,
  producer_run_id AS lineage_id,
  'legal' AS eligibility_status,
  'canonical_outcome_known' AS reason_code,
  label_schema_version AS contract_version,
  MAX(outcome_known_date) AS knowledge_cutoff,
  COUNT(*) AS sample_count,
  'canonical_selection_outcomes_v1' AS source_table
FROM canonical_selection_outcomes_v1
GROUP BY signal_date, producer_run_id, horizon_days, label_schema_version;

DROP VIEW IF EXISTS strategy_evidence_observations_v1;
CREATE VIEW strategy_evidence_observations_v1 AS
SELECT
  m.rowid AS matrix_row_id,
  m.signal_date,
  m.symbol,
  m.producer_run_id,
  m.strategy_id,
  m.strategy_version,
  m.strategy_status,
  m.alpha_bucket,
  m.affinity AS legacy_binary_affinity,
  m.affinity_version AS legacy_affinity_version,
  CASE
    WHEN m.challenger_affinity_version='strategy-threshold-margin-affinity-v2'
     AND m.affinity_evidence_count>0
    THEN m.challenger_affinity
    ELSE NULL
  END AS evidence_affinity,
  CASE
    WHEN m.challenger_affinity_version='strategy-threshold-margin-affinity-v2'
     AND m.affinity_evidence_count>0
    THEN m.challenger_affinity_version
    ELSE NULL
  END AS evidence_affinity_version,
  m.affinity_evidence_count,
  m.position_weight,
  m.overlap,
  o.horizon_days,
  o.outcome_known_date,
  o.entry_date,
  o.exit_date,
  o.absolute_return_net,
  o.benchmark_return_net,
  o.residual_return_net,
  o.cross_section_rank,
  (
    SELECT a.alpha_context
    FROM allocator_ev_feature_snapshots a
    WHERE a.snapshot_date=m.signal_date AND a.symbol=m.symbol
    ORDER BY a.generated_at DESC
    LIMIT 1
  ) AS alpha_context
FROM strategy_label_matrix_v4 m
JOIN canonical_selection_outcomes_v1 o
  ON o.signal_date=m.signal_date
 AND o.symbol=m.symbol
 AND o.producer_run_id=m.producer_run_id
WHERE m.strategy_hit=1 AND m.evaluable=1;
