-- Preserve historical adaptive-admission decisions under v1 while prospectively
-- switching each live technical strategy to the complete materialized signal.
-- Re-running is safe: an existing hard-signal version is not overwritten.
WITH technical(strategy_id, suffix) AS (
  VALUES
    ('stock_tech_s01_55d_trend_volume_breakout_v1', '01'),
    ('stock_tech_s02_52w_dual_momentum_v1', '02'),
    ('stock_tech_s04_ma_deduct_turn_breakout_v1', '04'),
    ('stock_tech_s06_nr7_inside_bar_breakout_v1', '06'),
    ('stock_tech_s11_gap_breakout_continuation_v1', '11')
)
INSERT OR IGNORE INTO strategy_spec_registry (
  strategy_id, version, name, status, owner, alpha_bucket,
  family_id, variant_id, owner_type, promotion_status,
  supported_regimes_json, thesis, thresholds_json, candidate_policy_json,
  risk_notes_json, source_refs_json, created_by, created_at, updated_at
)
SELECT old.strategy_id, 'strategy-spec-v1-hard-signal', old.name, old.status,
       old.owner, old.alpha_bucket, old.family_id, old.variant_id,
       old.owner_type, old.promotion_status, old.supported_regimes_json,
       old.thesis,
       json_remove(
         json_set(old.thresholds_json,
           '$.dsl.all', json_array(json_object(
             'signal', 'technicalIndicators.stockTechS' || technical.suffix || 'Signal',
             'op', '==', 'value', 1
           )),
           '$.technicalStrategy.requiresMaterializedSignal',
             'technicalIndicators.stockTechS' || technical.suffix || 'Signal',
           '$.technicalStrategy.scoreSignal',
             'technicalIndicators.stockTechS' || technical.suffix || 'Score'
         ),
         '$.technicalStrategy.requiresMaterializedAdmission',
         '$.technicalStrategy.admissionPolicy'
       ),
       json_set(
         old.candidate_policy_json,
         '$.evidenceRequirements',
         json((
           SELECT json_group_array(requirement.value)
             FROM json_each(old.candidate_policy_json, '$.evidenceRequirements') AS requirement
            WHERE requirement.value NOT LIKE 'materialized_admission:%'
         ))
       ),
       json_insert(
         json((
           SELECT json_group_array(note.value)
             FROM json_each(old.risk_notes_json) AS note
            WHERE note.value NOT LIKE '%adaptive score-priority admission%'
              AND note.value NOT LIKE '%materialized admission%'
              AND note.value NOT LIKE '%stockTechS%Admission%'
         )),
         '$[#]', 'Runtime match requires the complete materialized technical strategy signal; score is diagnostic evidence only.',
         '$[#]', 'Historical adaptive-admission decisions remain on strategy-spec-v1 and must not be combined with this version.'
       ),
       old.source_refs_json, 'stock_technical_hard_signal_20260923',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM strategy_spec_registry AS old
  JOIN technical ON technical.strategy_id = old.strategy_id
 WHERE old.version = 'strategy-spec-v1'
   AND old.status IN ('active', 'candidate')
   AND json_extract(old.thresholds_json, '$.dsl.all[0].signal') =
       'technicalIndicators.stockTechS' || technical.suffix || 'Admission';

UPDATE strategy_spec_registry
   SET status = 'retired',
       owner_type = 'retired',
       promotion_status = 'retired',
       updated_at = CURRENT_TIMESTAMP
 WHERE version = 'strategy-spec-v1'
   AND strategy_id IN (
     SELECT strategy_id
       FROM strategy_spec_registry
      WHERE version = 'strategy-spec-v1-hard-signal'
   )
   AND status IN ('active', 'candidate');
