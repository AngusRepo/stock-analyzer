import sys
from pathlib import Path

import pytest

sys.path.append(str(Path(__file__).resolve().parents[1]))

from services.allocator_ev_fusion import materialize_allocator_ev_fusion  # noqa: E402


def _artifact() -> dict:
    return {
        "schema_version": "allocator-ev-fusion-artifact-v1",
        "expected_return_owner": "allocator_ev_fusion",
        "promotion_state": "production_approved",
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


def test_allocator_ev_fusion_materializer_serves_edge_agreement_feature():
    payload = materialize_allocator_ev_fusion(
        {},
        l4_value=0.02,
        l4_source="l4_alpha_ev:test",
        l4_payload={"expected_return_owner": "l4_alpha_ev"},
        s12_value=0.01,
        s12_source="s12_trade_ev:test",
        s12_payload={"status": "loaded"},
        market_heat_expected_return=0.0,
        policy={"allocatorEvFusion": _artifact()},
    )

    assert payload is not None
    assert payload["status"] == "loaded"
    assert payload["feature_values"]["l4_s12_edge_agreement"] == pytest.approx(1.0)
    assert payload["expected_return"] == pytest.approx(0.04)


def test_allocator_ev_fusion_materializer_marks_edge_disagreement_zero():
    payload = materialize_allocator_ev_fusion(
        {},
        l4_value=0.02,
        l4_source="l4_alpha_ev:test",
        l4_payload={"expected_return_owner": "l4_alpha_ev"},
        s12_value=-0.01,
        s12_source="s12_trade_ev:test",
        s12_payload={"status": "loaded"},
        market_heat_expected_return=0.0,
        policy={"allocatorEvFusion": _artifact()},
    )

    assert payload is not None
    assert payload["status"] == "loaded"
    assert payload["feature_values"]["l4_s12_edge_agreement"] == pytest.approx(0.0)
    assert payload["expected_return"] == pytest.approx(0.01)


def test_allocator_ev_fusion_materializer_uses_availability_features_instead_of_disabling_execution_model():
    artifact = {
        **_artifact(),
        "schema_version": "allocator-ev-fusion-artifact-v3",
        "resolver_method": "two_stage_allocator_ev_fusion",
        "selection_model": {
            "status": "fitted",
            "intercept": 0.0,
            "feature_names": ["l4_expected_return"],
            "coefficients": {"l4_expected_return": 1.0},
        },
        "execution_model": {
            "status": "fitted",
            "intercept": -0.001,
            "feature_names": ["s12_trade_expected_return"],
            "coefficients": {"s12_trade_expected_return": 0.5},
        },
    }
    with_s12 = materialize_allocator_ev_fusion(
        {},
        l4_value=0.02,
        l4_source="l4:test",
        l4_payload={},
        s12_value=0.01,
        s12_source="s12:test",
        s12_payload={"status": "loaded"},
        market_heat_expected_return=0.0,
        policy={"allocatorEvFusion": artifact},
    )
    without_s12 = materialize_allocator_ev_fusion(
        {},
        l4_value=0.02,
        l4_source="l4:test",
        l4_payload={},
        s12_value=None,
        s12_source="s12:missing",
        s12_payload={"status": "invalid_structure"},
        market_heat_expected_return=0.0,
        policy={"allocatorEvFusion": artifact},
    )

    assert with_s12["expected_return"] == pytest.approx(0.024)
    assert with_s12["s12_execution_model_applied"] is True
    assert without_s12["expected_return"] == pytest.approx(0.019)
    assert without_s12["s12_execution_model_applied"] is True


def test_allocator_ev_fusion_materializer_probability_weights_execution_residual():
    artifact = {
        **_artifact(),
        "resolver_method": "rank_calibrated_two_part_allocator_ev_fusion",
        "selection_model": {
            "status": "fitted",
            "intercept": 0.0,
            "coefficients": {"l4_expected_return": 1.0},
        },
        "execution_model": {
            "status": "fitted",
            "intercept": 0.0,
            "coefficients": {"s12_trade_expected_return": 0.4},
        },
        "execution_probability_model": {
            "status": "fitted",
            "intercept": 0.5,
            "coefficients": {"s12_trade_expected_return": 0.0},
        },
    }
    payload = materialize_allocator_ev_fusion(
        {},
        l4_value=0.02,
        l4_source="l4:test",
        l4_payload={},
        s12_value=0.01,
        s12_source="s12:test",
        s12_payload={"status": "loaded"},
        market_heat_expected_return=0.0,
        policy={"allocatorEvFusion": artifact},
    )

    assert payload["execution_probability"] == pytest.approx(0.5)
    assert payload["raw_execution_residual"] == pytest.approx(0.004)
    assert payload["execution_residual_adjustment"] == pytest.approx(0.002)
    assert payload["expected_return"] == pytest.approx(0.022)


def test_allocator_ev_fusion_v5_uses_execution_probability_times_conditional_trade_return():
    artifact = {
        **_artifact(),
        "schema_version": "allocator-ev-fusion-artifact-v5",
        "resolver_method": "cross_fitted_rank_two_part_trade_ev_fusion",
        "expected_return_semantic": "execution_probability_times_conditional_replay_net_return",
        "selection_model": {
            "status": "fitted",
            "intercept": 0.0,
            "coefficients": {"l4_expected_return": 1.0},
        },
        "execution_model": {
            "status": "fitted",
            "intercept": 0.0,
            "coefficients": {"s12_trade_expected_return": 1.0},
        },
        "execution_probability_model": {
            "status": "fitted",
            "link_function": "logit",
            "intercept": 0.0,
            "coefficients": {"s12_trade_expected_return": 0.0},
        },
    }
    payload = materialize_allocator_ev_fusion(
        {},
        l4_value=0.02,
        l4_source="l4:test",
        l4_payload={},
        s12_value=0.01,
        s12_source="s12:test",
        s12_payload={"status": "loaded"},
        market_heat_expected_return=0.0,
        policy={"allocatorEvFusion": artifact},
    )

    assert payload["selection_expected_return"] == pytest.approx(0.02)
    assert payload["execution_probability"] == pytest.approx(0.5)
    assert payload["raw_execution_residual"] == pytest.approx(0.01)
    assert payload["expected_return"] == pytest.approx(0.005)
