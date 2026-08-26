from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active8_release_model_profiles import model_profile  # noqa: E402
from services.active8_release_training_contract import (  # noqa: E402
    ACTIVE8_MODEL_NAMES,
    RELEASE_ARTIFACT_LIFECYCLE_TARGETS,
    RELEASE_VALIDATION_CONTRACT,
    RELEASE_TRAIN_GROUPS,
    build_model_training_config_attestation,
    build_release_training_contract,
    normalize_release_execution_scope,
    validate_model_training_config_attestation,
    validate_release_training_contract,
    _checksum,
)


SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"


def _contract() -> dict:
    return build_release_training_contract(
        run_date="2026-08-24",
        dataset_snapshot={
            "snapshot_id": "backtest_dataset:2026-08-24:test",
            "business_date": "2026-08-24",
        },
        producer_source_sha=SOURCE_SHA,
    )


def test_release_scope_is_exactly_active8_and_cannot_silently_omit_models():
    groups, targets = normalize_release_execution_scope(["tree"], ["GNN"])

    assert tuple(groups) == RELEASE_TRAIN_GROUPS
    assert tuple(targets) == RELEASE_ARTIFACT_LIFECYCLE_TARGETS
    assert ACTIVE8_MODEL_NAMES == (
        "LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN", "DLinear", "PatchTST", "iTransformer"
    )


def test_release_scope_rejects_unknown_execution_paths():
    with pytest.raises(ValueError, match="release_training_group_not_allowed"):
        normalize_release_execution_scope(["tree", "legacy_ft"], [])
    with pytest.raises(ValueError, match="release_artifact_target_not_allowed"):
        normalize_release_execution_scope([], ["TimesFM"])


def test_release_contract_is_checksum_bound_to_exact_snapshot_and_source():
    contract = _contract()

    assert validate_release_training_contract(contract) == contract
    assert contract["dataset_snapshot_business_date"] == contract["run_date"]
    assert len(contract["dataset_snapshot_checksum"]) == 64
    assert contract["configuration_selection"]["cohort_pbo_must_not_be_used_as_per_model_pbo"] is True

    tampered = copy.deepcopy(contract)
    tampered["models"].pop()
    with pytest.raises(ValueError, match="checksum_mismatch"):
        validate_release_training_contract(tampered)


def test_release_contract_separates_runtime_and_immutable_input_provenance():
    input_source = "a" * 40
    snapshot = {
        "schema_version": "active8-oof-full-fit-prep-lineage-v2",
        "snapshot_id": "oof_full_fit:cohort-1:" + "b" * 64,
        "business_date": "2026-08-24",
        "producer_source_sha": input_source,
        "manifest_checksum": "c" * 64,
        "source_manifest_checksum": "b" * 64,
        "source_cohort_id": "cohort-1",
        "feature_pool": {"artifact_checksum": "d" * 64},
        "sequence": {"manifest_checksum": "e" * 64},
    }
    contract = build_release_training_contract(
        run_date="2026-08-24",
        dataset_snapshot=snapshot,
        producer_source_sha=SOURCE_SHA,
    )

    assert contract["producer_source_sha"] == SOURCE_SHA
    assert contract["input_lineage"] == {
        "prep_producer_source_sha": input_source,
        "prep_manifest_checksum": "c" * 64,
        "source_manifest_checksum": "b" * 64,
        "source_cohort_id": "cohort-1",
        "feature_pool_checksum": "d" * 64,
        "sequence_manifest_checksum": "e" * 64,
    }
    assert validate_release_training_contract(contract) == contract

    tampered = copy.deepcopy(contract)
    tampered["input_lineage"]["prep_producer_source_sha"] = "f" * 40
    with pytest.raises(ValueError, match="checksum_mismatch"):
        validate_release_training_contract(tampered)


def test_release_validation_semantics_reject_dlinear_one_fold_even_with_valid_checksum():
    contract = _contract()
    assert contract["validation"] == RELEASE_VALIDATION_CONTRACT

    tampered = copy.deepcopy(contract)
    tampered["validation"]["minimum_outer_folds"] = 1
    unsigned = {key: value for key, value in tampered.items() if key != "contract_checksum"}
    tampered["contract_checksum"] = _checksum(unsigned)

    with pytest.raises(ValueError, match="validation_semantic_mismatch"):
        validate_release_training_contract(tampered)


def test_fixed_config_attestation_is_model_specific_and_immutable():
    attestation = build_model_training_config_attestation(
        contract=_contract(),
        model_name="PatchTST",
        effective_config=model_profile("PatchTST")["required_effective_config"],
    )

    assert validate_model_training_config_attestation(
        attestation,
        expected_model_name="PatchTST",
    ) == attestation
    assert attestation["selection_trials"] == 1
    assert attestation["pbo_applicability"] == "not_applicable_without_model_configuration_selection"

    tampered = copy.deepcopy(attestation)
    tampered["effective_config"]["max_steps"] = 30
    with pytest.raises(ValueError, match="attestation_checksum_mismatch"):
        validate_model_training_config_attestation(tampered, expected_model_name="PatchTST")


def test_nonfinite_estimator_params_are_canonicalized_before_attestation():
    attestation = build_model_training_config_attestation(
        contract=_contract(),
        model_name="XGBoost",
        effective_config={
            **model_profile("XGBoost")["required_effective_config"],
            "estimator_params": {
                **model_profile("XGBoost")["required_effective_config"]["estimator_params"],
                "missing": float("nan"),
                "max_delta_step": float("inf"),
            },
        },
    )

    params = attestation["effective_config"]["estimator_params"]
    assert params["missing"] == "nonfinite:nan"
    assert params["max_delta_step"] == "nonfinite:inf"
    assert validate_model_training_config_attestation(attestation, expected_model_name="XGBoost") == attestation
