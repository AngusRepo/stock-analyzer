from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.allocator_ev_fusion import (  # noqa: E402
    assess_allocator_ev_fusion_policy,
    materialize_allocator_ev_fusion,
)
from services.evidence_contracts import (  # noqa: E402
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
    ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    LABEL_SCHEMA_VERSION,
)


def _artifact(**overrides):
    artifact = {
        "schema_version": "allocator-ev-fusion-artifact-v14",
        "artifact_contract_version": ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_primary",
        "promotion_tier": "primary",
        "primary_expected_return_allowed": True,
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "day_t_causal_l4_residual_overlay",
        "model_version": "allocator-ev-fusion-residual-v14-test",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v14-day-t-causal",
        "expected_return_semantic": "l4_base_expected_return_plus_validated_residual_adjustment",
        "base_expected_return_owner": "l4_alpha_ev",
        "trained_until": "2026-08-01",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "policy_value_head_count": 1,
        "policy_value_heads": ["residual_adjustment_model"],
        "residual_adjustment_model": {
            "status": "fitted",
            "decision": "PASS",
            "head_semantic": "canonical_five_session_net_return_minus_point_in_time_l4_alpha_ev",
            "intercept": 0.02,
            "coefficients": {
                "l4_expected_return": 0.0,
                "market_heat_expected_return": 0.0,
            },
        },
        "residual_output_clip": {"min": -0.08, "max": 0.08},
    }
    artifact.update(overrides)
    return artifact


def _materialize(artifact, *, row=None, l4_value=0.01):
    return materialize_allocator_ev_fusion(
        row or {},
        l4_value=l4_value,
        l4_source="l4_alpha_ev:test",
        l4_payload={"status": "loaded", "expected_return_owner": "l4_alpha_ev"},
        market_heat_expected_return=0.003,
        policy={"allocatorEvFusion": artifact},
    )


def test_materializer_serves_l4_plus_validated_residual_only():
    payload = _materialize(_artifact())

    assert payload is not None
    assert payload["status"] == "loaded"
    assert payload["overlay_status"] == "applied"
    assert payload["expected_return_owner"] == "allocator_ev_fusion"
    assert payload["policy_value_head_count"] == 1
    assert payload["base_expected_return_owner"] == "l4_alpha_ev"
    assert payload["base_expected_return"] == pytest.approx(0.01)
    assert payload["fusion_residual_adjustment"] == pytest.approx(0.02)
    assert payload["final_expected_return"] == pytest.approx(0.03)
    assert payload["policy_value"] == pytest.approx(0.03)
    assert payload["expected_return"] == pytest.approx(0.03)
    assert "selection_expected_return" not in payload
    assert "s12_trade_ev" not in payload
    assert payload["selection_feature_owner"] == "l4_alpha_ev"
    assert "execution_policy_owner" not in payload


def test_materializer_uses_day_t_features_for_residual_adjustment():
    artifact = _artifact(
        residual_adjustment_model={
            "status": "fitted",
            "decision": "PASS",
            "intercept": 0.0,
            "coefficients": {"l4_expected_return": 0.5},
        },
    )
    payload = _materialize(artifact, l4_value=0.04)

    assert payload["status"] == "loaded"
    assert payload["base_expected_return"] == pytest.approx(0.04)
    assert payload["fusion_residual_adjustment"] == pytest.approx(0.02)
    assert payload["expected_return"] == pytest.approx(0.06)
    assert payload["feature_values"]["l4_expected_return"] == pytest.approx(0.04)
    assert all(not name.startswith("s12_") for name in payload["feature_values"])


def test_materializer_rejects_third_selection_serving_head():
    artifact = _artifact(
        selection_model={
            "status": "fitted",
            "intercept": 0.0,
            "coefficients": {"l4_expected_return": 1.0},
        },
    )
    payload = _materialize(artifact)

    assert payload["status"] == "rejected"
    assert "third_selection_serving_head_forbidden" in payload["blockers"]


def test_materializer_rejects_candidate_time_s12_features_in_residual_head():
    artifact = _artifact(
        residual_adjustment_model={
            "status": "fitted",
            "decision": "PASS",
            "intercept": 0.0,
            "coefficients": {
                "l4_expected_return": 1.0,
                "s12_trade_expected_return": 1.0,
            },
        },
    )
    payload = _materialize(artifact)

    assert payload["status"] == "rejected"
    assert "candidate_time_s12_feature_forbidden:s12_trade_expected_return" in payload["blockers"]


def test_materializer_rejects_legacy_contract_and_non_primary_artifact():
    legacy = _artifact(artifact_contract_version="allocator-ev-fusion-contract-v12")
    legacy_payload = _materialize(legacy)
    assert legacy_payload["status"] == "rejected"
    assert "artifact_contract_version_incompatible" in legacy_payload["blockers"]

    shadow = _artifact(
        promotion_state="shadow",
        promotion_tier="shadow",
        primary_expected_return_allowed=False,
    )
    shadow_payload = _materialize(shadow)
    assert shadow_payload["status"] == "rejected"
    assert "production_approval_missing" in shadow_payload["blockers"]
    readiness = assess_allocator_ev_fusion_policy({"allocatorEvFusion": shadow})
    assert readiness["ready"] is False
    assert "production_approval_missing" in readiness["blockers"]
    assert "primary_expected_return_not_allowed" in readiness["blockers"]


def test_materializer_public_api_has_no_candidate_s12_arguments():
    with pytest.raises(TypeError):
        materialize_allocator_ev_fusion(
            {},
            l4_value=0.01,
            l4_source="l4:test",
            l4_payload={},
            s12_value=0.02,
            market_heat_expected_return=0.0,
            policy={"allocatorEvFusion": _artifact()},
        )
