-- Quarantine replay rows that were marked sample-eligible before the complete
-- V3 engine/entry/calibration/cohort lineage contract was persisted. Outcomes
-- remain available for audit and signed replay repair, but cannot enter EV learning.
UPDATE s12_replay_trade_outcomes
   SET sample_eligible = 0,
       detail_json = json_set(
         CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,
         '$.lineage_validation.status', 'quarantined_incomplete_v3_lineage',
         '$.lineage_validation.previous_sample_eligible', 1,
         '$.lineage_validation.contract', 'persisted_engine_entry_calibration_cohort_required_v1',
         '$.lineage_validation.quarantined_at', '2026-07-16T00:00:00Z'
       )
 WHERE source = 's12_multisession_structure_replay_v3'
   AND sample_eligible = 1
   AND (
     COALESCE(json_extract(detail_json, '$.replay_diagnostics.replay_engine_signature'), '') != 's12_replay_v3:tw_equity_raw_daily_namespace_safe:overlapping_r2_pit:five_session_price_domain:v2'
     OR COALESCE(json_extract(detail_json, '$.replay_diagnostics.entry_policy_signature'), '') = ''
     OR COALESCE(json_extract(detail_json, '$.replay_diagnostics.exit_calibration_signature'), '') = ''
     OR COALESCE(json_extract(detail_json, '$.replay_diagnostics.replay_cohort_signature'), '') = ''
     OR json_extract(detail_json, '$.replay_diagnostics.replay_cohort_signature') != (
       's12_replay_v3:tw_equity_raw_daily_namespace_safe:overlapping_r2_pit:five_session_price_domain:v2'
       || '|entry=' || lower(json_extract(detail_json, '$.replay_diagnostics.entry_policy_signature'))
       || '|calibration=' || json_extract(detail_json, '$.replay_diagnostics.exit_calibration_signature')
     )
   );
