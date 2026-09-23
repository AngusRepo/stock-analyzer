-- Preserve the verified JSON original for the same ten-year audit contract.
UPDATE data_retention_policies SET cold_retention_days=3650,version=version+1,updated_at=CURRENT_TIMESTAMP
WHERE policy_id='audit_json_r2_v1' AND (cold_retention_days IS NULL OR cold_retention_days<3650);
