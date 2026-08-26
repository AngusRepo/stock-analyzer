from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active8_monthly_model_profiles import model_profile  # noqa: E402
from services.active8_monthly_training_contract import (  # noqa: E402
    ACTIVE8_MODEL_NAMES,
    MONTHLY_ARTIFACT_LIFECYCLE_TARGETS,
    MONTHLY_TRAIN_GROUPS,
    build_model_training_config_attestation,
    build_monthly_training_contract,
    normalize_monthly_execution_scope,
    validate_model_training_config_attestation,
    validate_monthly_training_contract,
)


SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"


def _contract() -> dict:
    return build_monthly_training_contract(
        run_date="2026-08-24",
        dataset_snapshot={
            "snapshot_id": "backtest_dataset:2026-08-24:test",
            "business_date": "2026-08-24",
        },
        producer_source_sha=SOURCE_SHA,
    )


def test_monthly_scope_is_exactly_active8_and_cannot_silently_omit_models():
    groups, targets = normalize_monthly_execution_scope(["tree"], ["GNN"])

    assert tuple(groups) == MONTHLY_TRAIN_GROUPS
    assert tuple(targets) == MONTHLY_ARTIFACT_LIFECYCLE_TARGETS
    assert ACTIVE8_MODEL_NAMES == (
        "LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN", "DLinear", "PatchTST", "iTransformer"
    )


def test_monthly_scope_rejects_unknown_execution_paths():
    with pytest.raises(ValueError, match="monthly_training_group_not_allowed"):
        normalize_monthly_execution_scope(["tree", "legacy_ft"], [])
    with pytest.raises(ValueError, match="monthly_artifact_target_not_allowed"):
        normalize_monthly_execution_scope([], ["TimesFM"])


def test_monthly_contract_is_checksum_bound_to_exact_snapshot_and_source():
    contract = _contract()

    assert validate_monthly_training_contract(contract) == contract
    assert contract["dataset_snapshot_business_date"] == contract["run_date"]
    assert contract["configuration_selection"]["cohort_pbo_must_not_be_used_as_per_model_pbo"] is True

    tampered = copy.deepcopy(contract)
    tampered["models"].pop()
    with pytest.raises(ValueError, match="checksum_mismatch"):
        validate_monthly_training_contract(tampered)


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
