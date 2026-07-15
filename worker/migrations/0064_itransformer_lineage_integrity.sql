-- Repair the exact serving artifact integrity and preserve the 2026-06-30 rollback
-- as a distinct point-in-time champion event. The superseded synthetic event is
-- retained for audit but downgraded so it cannot enter exact lineage resolution.
UPDATE model_artifact_registry
SET checksum = 'sha256:c6fbe28afc63bea4eec88cbfa9a2ee78a09cb480c39161f477f3fc853cda7335',
    updated_at = CURRENT_TIMESTAMP
WHERE artifact_id = 'iTransformer:v20260612T141342_itransformer_nf:production_backfill'
  AND artifact_path = 'universal/itransformer/v20260612T141342_itransformer_nf.zip'
  AND (checksum IS NULL OR trim(checksum) = '');

UPDATE model_champion_history
SET evidence_grade = 'unknown',
    retired_at = COALESCE(retired_at, effective_at),
    evidence_json = '{"source":"universal/model_pool.json","status":"superseded_invalid_synthetic_event","reason":"current_version_rollback_reused_stale_promoted_at","superseded_by":["champion-repair:iTransformer:v20260621154455:2026-06-21T16:25:07.891989Z","champion-repair:iTransformer:v20260612T141342_itransformer_nf:2026-06-30T15:32:58Z"]}'
WHERE event_id = 'champion-backfill:iTransformer:v20260612T141342_itransformer_nf:2026-06-21T16:25:07.891989+00:00'
  AND version = 'v20260612T141342_itransformer_nf'
  AND effective_at = '2026-06-21T16:25:07.891989+00:00'
  AND evidence_grade = 'exact';

INSERT OR IGNORE INTO model_champion_history (
  event_id, model_name, version, artifact_id, effective_at, retired_at,
  source, evidence_grade, evidence_json
) VALUES (
  'champion-repair:iTransformer:v20260621154455:2026-06-21T16:25:07.891989Z',
  'iTransformer', 'v20260621154455',
  'iTransformer:v20260621154455:monthly_release',
  '2026-06-21T16:25:07.891989+00:00', '2026-06-30T15:32:58Z',
  'model_champion_history', 'exact',
  '{"source":"model_artifact_registry+model_champion_pointers","status":"reconstructed_exact_transition","promotion_reason":"formal artifact lifecycle target=iTransformer run_id=universal-20260621T231108-40d3a660","retirement_reason":"manual_d1_cleanup_rollback_failed_monthly_20260630"}'
);

INSERT OR IGNORE INTO model_champion_history (
  event_id, model_name, version, artifact_id, effective_at, retired_at,
  source, evidence_grade, evidence_json
) VALUES (
  'champion-repair:iTransformer:v20260612T141342_itransformer_nf:2026-06-30T15:32:58Z',
  'iTransformer', 'v20260612T141342_itransformer_nf',
  'iTransformer:v20260612T141342_itransformer_nf:production_backfill',
  '2026-06-30T15:32:58Z', NULL,
  'model_champion_history', 'exact',
  '{"source":"model_champion_pointers","status":"exact_manual_rollback","promotion_reason":"manual_d1_cleanup_rollback_failed_monthly_20260630","approved_by":"Wei","pointer_promoted_at":"2026-06-30 15:32:58"}'
);
