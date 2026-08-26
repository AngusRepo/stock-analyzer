from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active8_monthly_model_profiles import model_profile  # noqa: E402
from services.active8_monthly_training_contract import (  # noqa: E402
    ACTIVE8_MODEL_NAMES,
    build_model_training_config_attestation,
    build_monthly_training_contract,
    reconcile_monthly_artifact_receipts_from_immutable_metadata,
    validate_monthly_artifact_receipts,
)


def _contract() -> dict:
    return build_monthly_training_contract(
        run_date="2026-08-25",
        dataset_snapshot={"business_date": "2026-08-25", "snapshot_id": "snapshot:2026-08-25"},
        producer_source_sha="0123456789abcdef0123456789abcdef01234567",
    )


def _receipts(contract: dict) -> dict[str, dict]:
    receipts = {}
    for model in ACTIVE8_MODEL_NAMES:
        attestation = build_model_training_config_attestation(
            contract=contract,
            model_name=model,
            effective_config=model_profile(model)["required_effective_config"],
        )
        receipts[model] = {
            "version": "vMonthly",
            "artifact_path": f"universal/{model.lower()}/vMonthly.bin",
            "metadata_path": f"universal/{model.lower()}/metadata_vMonthly.json",
            "checksum": "a" * 64,
            "metadata": {
                "version": "vMonthly",
                "artifact_path": f"universal/{model.lower()}/vMonthly.bin",
                "checksum": "a" * 64,
                "model_training_config_attestation": attestation,
            },
        }
    return receipts


def test_monthly_completion_requires_exactly_eight_checksum_bound_artifacts():
    contract = _contract()
    receipt = validate_monthly_artifact_receipts(contract=contract, receipts=_receipts(contract))

    assert receipt["status"] == "complete"
    assert receipt["models_completed"] == receipt["models_required"] == 8
    assert tuple(receipt["receipts"]) == ACTIVE8_MODEL_NAMES


def test_monthly_completion_accepts_canonical_tree_model_pool_version_identity():
    contract = _contract()
    receipts = _receipts(contract)
    metadata = receipts["LightGBM"]["metadata"]
    metadata.pop("version")
    metadata["model_pool_version"] = "vMonthly"

    receipt = validate_monthly_artifact_receipts(contract=contract, receipts=receipts)

    assert receipt["receipts"]["LightGBM"]["version"] == "vMonthly"


def test_monthly_completion_rejects_tree_model_pool_version_mismatch():
    contract = _contract()
    receipts = _receipts(contract)
    metadata = receipts["LightGBM"]["metadata"]
    metadata.pop("version")
    metadata["model_pool_version"] = "vWrong"

    with pytest.raises(ValueError, match="metadata_version_mismatch:LightGBM"):
        validate_monthly_artifact_receipts(contract=contract, receipts=receipts)


def test_monthly_completion_reconciles_from_exact_immutable_metadata():
    contract = _contract()

    receipt = reconcile_monthly_artifact_receipts_from_immutable_metadata(
        contract_stage={"status": "verified", "checksum": contract["contract_checksum"]},
        run_date=contract["run_date"],
        dataset_snapshot={
            "business_date": contract["run_date"],
            "snapshot_id": contract["dataset_snapshot_id"],
        },
        raw_receipts=_receipts(contract),
    )

    assert receipt["status"] == "complete"
    assert receipt["models_completed"] == 8


def test_monthly_completion_reconciliation_rejects_different_contract():
    contract = _contract()

    with pytest.raises(ValueError, match="contract_checksum_mismatch"):
        reconcile_monthly_artifact_receipts_from_immutable_metadata(
            contract_stage={"status": "verified", "checksum": "b" * 64},
            run_date=contract["run_date"],
            dataset_snapshot={
                "business_date": contract["run_date"],
                "snapshot_id": contract["dataset_snapshot_id"],
            },
            raw_receipts=_receipts(contract),
        )


def test_monthly_completion_fails_closed_on_missing_or_wrong_profile_artifact():
    contract = _contract()
    missing = _receipts(contract)
    missing.pop("PatchTST")
    with pytest.raises(ValueError, match="model_set_mismatch"):
        validate_monthly_artifact_receipts(contract=contract, receipts=missing)

    tampered = _receipts(contract)
    tampered_attestation = copy.deepcopy(
        tampered["PatchTST"]["metadata"]["model_training_config_attestation"]
    )
    tampered_attestation["effective_config"]["max_steps"] = 30
    tampered["PatchTST"]["metadata"]["model_training_config_attestation"] = tampered_attestation
    with pytest.raises(ValueError, match="attestation_checksum_mismatch"):
        validate_monthly_artifact_receipts(contract=contract, receipts=tampered)
