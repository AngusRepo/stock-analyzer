import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from services.allocator_ev_fusion import assess_allocator_ev_fusion_policy  # noqa: E402
from services.evidence_contracts import (  # noqa: E402
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
    ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    LABEL_SCHEMA_VERSION,
)


def _artifact() -> dict:
    return {
        "schema_version": "allocator-ev-fusion-artifact-v13",
        "artifact_contract_version": ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
        "feature_semantic_version": ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
        "label_schema_version": LABEL_SCHEMA_VERSION,
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_primary",
        "promotion_tier": "primary",
        "primary_expected_return_allowed": True,
        "validation_packet": {"decision": "PASS"},
        "resolver_method": "day_t_causal_s12_policy_value_hurdle_fusion",
        "model_version": "allocator-ev-fusion-policy-value-v13-test",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v13-day-t-causal",
        "trained_until": "2026-08-01",
        "horizon_days": 5,
        "cost_model_bps": 18,
        "output_is_net_of_costs": True,
        "expected_return_semantic": "execution_probability_times_conditional_replay_net_return",
        "policy_value_head_count": 2,
        "conditional_execution_return_model": {
            "status": "fitted",
            "intercept": 0.01,
            "coefficients": {"l4_expected_return": 1.0},
        },
        "execution_probability_model": {
            "status": "fitted",
            "link_function": "logit",
            "intercept": 0.0,
            "coefficients": {"l4_available": 1.0},
        },
    }


def test_allocator_ev_fusion_policy_preflight_uses_v13_two_head_runtime_contract():
    accepted = assess_allocator_ev_fusion_policy({"allocatorEvFusion": _artifact()})
    rejected = assess_allocator_ev_fusion_policy(
        {"allocatorEvFusion": {**_artifact(), "artifact_contract_version": "legacy"}}
    )

    assert accepted["ready"] is True
    assert accepted["artifact_model_version"] == "allocator-ev-fusion-policy-value-v13-test"
    assert accepted["blockers"] == []
    assert rejected["ready"] is False
    assert "artifact_contract_version_incompatible" in rejected["blockers"]


def test_daily_pipeline_exposes_fusion_only_serving_preflight():
    source = (Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py").read_text(
        encoding="utf-8"
    )

    assert "fusion_serving_preflight = assess_allocator_ev_fusion_policy(alpha_policy)" in source
    assert '"schema_version": "expected-return-serving-preflight-v1"' in source
    assert 'serving_owner = "allocator_ev_fusion"' in source
    assert '"action_gate": "expected_return_owner" if serving_owner else "fusion_primary_required"' in source
    assert '"expected_return_serving_preflight": expected_return_serving_preflight' in source
