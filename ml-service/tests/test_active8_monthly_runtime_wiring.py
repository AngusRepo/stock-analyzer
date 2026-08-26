from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-service"))
sys.path.insert(0, str(ROOT / "ml-controller"))

from app.training_policy import build_model_training_config_attestation  # noqa: E402
from services.active8_monthly_model_profiles import model_profile, monthly_model_payload  # noqa: E402
from services.active8_monthly_training_contract import (  # noqa: E402
    MONTHLY_ARTIFACT_LIFECYCLE_TARGETS,
    MONTHLY_TRAIN_GROUPS,
    build_monthly_training_contract,
    validate_model_training_config_attestation,
)


def _contract() -> dict:
    return build_monthly_training_contract(
        run_date="2026-08-25",
        dataset_snapshot={"business_date": "2026-08-25", "snapshot_id": "snapshot:2026-08-25"},
        producer_source_sha="0123456789abcdef0123456789abcdef01234567",
    )


def test_modal_side_attestation_enforces_predeclared_patchtst_profile():
    profile = model_profile("PatchTST")
    payload = {
        "candidate_type": "monthly_release",
        "monthly_training_contract": _contract(),
    }

    attestation = build_model_training_config_attestation(
        "PatchTST",
        payload,
        profile["required_effective_config"],
    )

    assert attestation["model_profile"] == profile
    assert profile["runtime"]["research_gate_passed"] is True
    assert profile["runtime"]["research_production_effect"] is False
    assert profile["runtime"]["research_runs"] == 15
    assert profile["runtime"]["research_receipt_sha256"] == "e369dc7541a91d03dad4c66d8bac6ced8092c6fc3b8e7b193f7a31336712a675"
    assert profile["runtime"]["research_source_bundle_checksum"] == "68106ea56ca74d8c31a3475107a2ee71c589290dced584a2386a144e5a1f693a"
    receipt_path = ROOT / profile["runtime"]["research_summary_receipt_path"]
    receipt_bytes = receipt_path.read_bytes()
    assert hashlib.sha256(receipt_bytes).hexdigest() == profile["runtime"]["research_summary_receipt_sha256"]
    receipt = json.loads(receipt_bytes)
    assert receipt["research_gate"]["passed"] is True
    assert receipt["production_effect"] is False
    assert receipt["canonical_full_receipt"]["sha256"] == profile["runtime"]["research_receipt_sha256"]
    assert attestation["effective_config"]["max_steps"] == 120
    assert attestation["effective_config"]["training_options"]["oof_training_history_mode"] == "full_pit_history"

    invalid = dict(profile["required_effective_config"])
    invalid["max_steps"] = 30
    with pytest.raises(ValueError, match="profile_value_mismatch"):
        build_model_training_config_attestation("PatchTST", payload, invalid)


def test_modal_attestation_canonicalizes_nonfinite_estimator_params():
    contract = _contract()
    payload = {"candidate_type": "monthly_release", "monthly_training_contract": contract}
    effective = {
        **contract["model_profiles"]["XGBoost"]["required_effective_config"],
        "estimator_params": {
            **contract["model_profiles"]["XGBoost"]["required_effective_config"]["estimator_params"],
            "missing": float("nan"),
            "max_delta_step": float("-inf"),
        },
    }

    attestation = build_model_training_config_attestation("XGBoost", payload, effective)

    params = attestation["effective_config"]["estimator_params"]
    assert params["missing"] == "nonfinite:nan"
    assert params["max_delta_step"] == "nonfinite:-inf"
    json.dumps(attestation, allow_nan=False)
    assert validate_model_training_config_attestation(attestation, expected_model_name="XGBoost") == attestation


def test_all_neural_monthly_profiles_require_deterministic_seed_and_correct_accelerator():
    for model in ("TabM", "GNN", "DLinear", "PatchTST", "iTransformer"):
        profile = model_profile(model)
        assert profile["runtime"]["executor"] == "modal_l4"
        assert monthly_model_payload(model)["seed"] == 42
        required = profile["required_effective_config"]
        assert required["seed"] == 42
        assert required.get("device", required.get("runtime_device")) == "cuda"
        assert required["reproducibility"]["torch_deterministic_algorithms"] is True
        assert required["reproducibility"]["torch_deterministic_warn_only"] is True
        assert required["reproducibility"]["cudnn_benchmark"] is False


def test_patchtst_has_one_monthly_training_owner_and_one_artifact_receipt():
    assert "patchtst" in MONTHLY_TRAIN_GROUPS
    assert "PatchTST" not in MONTHLY_ARTIFACT_LIFECYCLE_TARGETS

    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    assert '(("DLinear", "dlinear"), ("PatchTST", "patchtst"))' in source
    assert 'artifact_registrations[model_name]' in source


def test_modal_orchestrator_wires_profiles_into_monthly_and_outer_oof_paths():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert '.env({"PYTHONHASHSEED": "42", "CUBLAS_WORKSPACE_CONFIG": ":4096:8"' in source
    assert 'base_train_payload.update(monthly_model_payload("LightGBM"))' in source
    assert '**(monthly_model_payload("DLinear") if is_monthly else {})' in source
    assert '**(monthly_model_payload("PatchTST") if is_monthly else {})' in source
    assert '**(monthly_model_payload(model_name) if is_monthly else {})' in source
    assert 'model_payload = {**train_payload, **active8_model_payload(model_name)}' in source
    assert 'validate_monthly_artifact_receipts(' in source
    assert '"monthly_active8_completion_incomplete"' in source
