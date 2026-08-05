from __future__ import annotations

import math
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
        "schema_version": "allocator-ev-fusion-artifact-v13",
        "artifact_contract_version": ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_primary",
        "promotion_tier": "primary",
        "primary_expected_return_allowed": True,
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "resolver_method": "day_t_causal_s12_policy_value_hurdle_fusion",
        "model_version": "allocator-ev-fusion-policy-value-v13-test",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v13-day-t-causal",
        "expected_return_semantic": "execution_probability_times_conditional_replay_net_return",
        "trained_until": "2026-08-01",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "policy_value_head_count": 2,
        "policy_value_heads": [
            "execution_probability_model",
            "conditional_execution_return_model",
        ],
        "conditional_execution_return_model": {
            "status": "fitted",
            "decision": "PASS",
            "head_semantic": "conditional_execution_return_model",
            "intercept": 0.02,
            "coefficients": {
                "l4_expected_return": 0.0,
                "market_heat_expected_return": 0.0,
            },
        },
        "execution_probability_model": {
            "status": "fitted",
            "decision": "PASS",
            "head_semantic": "execution_probability_model",
            "link_function": "logit",
            "intercept": 0.0,
            "coefficients": {
                "l4_available": 0.0,
            },
        },
        "output_clip": {"min": -0.08, "max": 0.08},
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


def test_materializer_serves_two_head_policy_value_only():
    payload = _materialize(_artifact())

    assert payload is not None
    assert payload["status"] == "loaded"
    assert payload["expected_return_owner"] == "allocator_ev_fusion"
    assert payload["policy_value_head_count"] == 2
    assert payload["execution_probability"] == pytest.approx(0.5)
    assert payload["conditional_execution_return"] == pytest.approx(0.02)
    assert payload["policy_value"] == pytest.approx(0.01)
    assert payload["expected_return"] == pytest.approx(0.01)
    assert "selection_expected_return" not in payload
    assert "s12_trade_ev" not in payload
    assert payload["selection_feature_owner"] == "l4_alpha_ev"
    assert payload["execution_policy_owner"] == "s12_intraday_structure_v1"


def test_materializer_uses_day_t_features_for_both_heads():
    artifact = _artifact(
        conditional_execution_return_model={
            "status": "fitted",
            "decision": "PASS",
            "intercept": 0.0,
            "coefficients": {"l4_expected_return": 1.0},
        },
        execution_probability_model={
            "status": "fitted",
            "decision": "PASS",
            "link_function": "logit",
            "intercept": 0.0,
            "coefficients": {"l4_available": math.log(3.0)},
        },
    )
    payload = _materialize(artifact, l4_value=0.04)

    assert payload["status"] == "loaded"
    assert payload["execution_probability"] == pytest.approx(0.75)
    assert payload["conditional_execution_return"] == pytest.approx(0.04)
    assert payload["expected_return"] == pytest.approx(0.03)
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


def test_materializer_rejects_candidate_time_s12_features_in_either_head():
    artifact = _artifact(
        conditional_execution_return_model={
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
