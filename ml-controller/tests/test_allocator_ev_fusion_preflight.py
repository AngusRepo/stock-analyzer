import sys
from pathlib import Path


sys.path.append(str(Path(__file__).resolve().parents[1]))

from services.allocator_ev_fusion import assess_allocator_ev_fusion_policy  # noqa: E402


def _artifact() -> dict:
    return {
        "schema_version": "allocator-ev-fusion-artifact-v1",
        "artifact_contract_version": "allocator-ev-fusion-contract-v11",
        "feature_semantic_version": "allocator-ev-fusion-directional-components-v2-lineage-bound",
        "label_schema_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_primary",
        "primary_expected_return_allowed": True,
        "validation_packet": {"decision": "PASS"},
        "resolver_method": "ridge_allocator_ev_fusion",
        "model_version": "allocator-ev-fusion-test",
        "feature_snapshot_version": "allocator-ev-fusion-feature-snapshot-v1",
        "trained_until": "2026-07-06",
        "horizon_days": 5,
        "cost_model_bps": 0,
        "output_is_net_of_costs": True,
        "feature_names": [
            "l4_expected_return",
            "s12_trade_expected_return",
            "l4_s12_edge_agreement",
        ],
        "intercept": 0.0,
        "coefficients": {
            "l4_expected_return": 1.0,
            "s12_trade_expected_return": 1.0,
            "l4_s12_edge_agreement": 0.01,
        },
    }


def test_allocator_ev_fusion_policy_preflight_uses_runtime_materialization_contract():
    accepted = assess_allocator_ev_fusion_policy({"allocatorEvFusion": _artifact()})
    rejected = assess_allocator_ev_fusion_policy(
        {"allocatorEvFusion": {**_artifact(), "artifact_contract_version": "legacy"}}
    )

    assert accepted["ready"] is True
    assert accepted["artifact_model_version"] == "allocator-ev-fusion-test"
    assert accepted["blockers"] == []
    assert rejected["ready"] is False
    assert "artifact_contract_version_incompatible" in rejected["blockers"]


def test_daily_pipeline_exposes_combined_l4_and_fusion_serving_preflight():
    source = Path("ml-controller/graphs/daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "fusion_serving_preflight = assess_allocator_ev_fusion_policy(alpha_policy)" in source
    assert '"schema_version": "expected-return-serving-preflight-v1"' in source
    assert '"expected_return_owner": serving_owner' in source
    assert '"action_gate": "expected_return_owner" if serving_owner else "validated_s12_only"' in source
    assert '"expected_return_serving_preflight": expected_return_serving_preflight' in source
