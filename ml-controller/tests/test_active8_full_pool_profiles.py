from copy import deepcopy
import pytest
from services.active8_release_model_profiles import (
    model_profiles, validate_profiles, MODEL_PROFILE_SCHEMA_VERSION,
    LEGACY_MODEL_PROFILE_SCHEMA_VERSION)


def test_new_profiles_remove_caps_without_changing_model_capacity():
    legacy = model_profiles(schema_version=LEGACY_MODEL_PROFILE_SCHEMA_VERSION)
    current = model_profiles()
    for name in ("PatchTST", "iTransformer"):
        assert current[name]["payload_config"]["max_series"] == 0
        assert legacy[name]["payload_config"]["max_series"] == 1024
        adjusted = deepcopy(current[name])
        for section in ("payload_config", "required_effective_config"):
            adjusted[section]["max_series"] = 1024
        assert adjusted == legacy[name]
    assert validate_profiles(legacy, schema_version=LEGACY_MODEL_PROFILE_SCHEMA_VERSION) == legacy
    with pytest.raises(ValueError, match="mismatch"):
        validate_profiles(legacy, schema_version=MODEL_PROFILE_SCHEMA_VERSION)
    assert validate_profiles(current) == current


@pytest.mark.parametrize("schema", [LEGACY_MODEL_PROFILE_SCHEMA_VERSION, MODEL_PROFILE_SCHEMA_VERSION])
def test_monthly_reconciliation_preserves_the_attested_profile_version(schema):
    from services.active8_release_training_contract import (
        ACTIVE8_MODEL_NAMES, build_release_training_contract,
        build_model_training_config_attestation, reconcile_release_artifact_receipts_from_immutable_metadata)
    snapshot = {"snapshot_id": "frozen", "business_date": "2026-09-14"}
    contract = build_release_training_contract(run_date="2026-09-14", dataset_snapshot=snapshot,
        producer_source_sha="a"*40, model_profile_schema_version=schema)
    raw = {}
    for name in ACTIVE8_MODEL_NAMES:
        metadata = {"version": "test", "checksum": "b"*64,
            "model_training_config_attestation": build_model_training_config_attestation(
                contract=contract, model_name=name,
                effective_config=contract["model_profiles"][name]["required_effective_config"])}
        raw[name] = {"version": "test", "artifact_path": name+".bin",
                     "metadata_path": name+".json", "checksum": "b"*64, "metadata": metadata}
    result = reconcile_release_artifact_receipts_from_immutable_metadata(run_date="2026-09-14",
        dataset_snapshot=snapshot, contract_stage={"status": "verified", "checksum": contract["contract_checksum"]}, raw_receipts=raw)
    assert result["status"] == "complete"
    assert result["models_completed"] == 8
