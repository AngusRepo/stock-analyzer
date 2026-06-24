from __future__ import annotations

import asyncio
from pathlib import Path

import sys
import types

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _install_daily_pipeline_import_stubs():
    graph_mod = types.ModuleType("langgraph.graph")
    graph_mod.END = object()
    graph_mod.StateGraph = object
    types_mod = types.ModuleType("langgraph.types")
    types_mod.RetryPolicy = object
    sys.modules.setdefault("langgraph.graph", graph_mod)
    sys.modules.setdefault("langgraph.types", types_mod)
    httpx_mod = types.ModuleType("httpx")
    httpx_mod.AsyncClient = object
    sys.modules.setdefault("httpx", httpx_mod)


def test_daily_pipeline_refuses_watchlist_screener_fallback():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "screener_recs_missing" in source
    assert "refusing watchlist fallback" in source
    assert "build_screener_seed_recommendations(" not in source
    assert "load_active_stocks" not in source
    assert "build_ml_universe([], screener_recs)" in source


def test_daily_pipeline_loads_latest_screener_seed_without_recommendation_inner_join():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "FROM candidate_seed sfi" in source
    assert "LEFT JOIN daily_recommendations dr" in source
    assert "JOIN candidate_seed sfi" not in source
    assert "source=latest_screener_candidate_seed" in source
    assert "strategy_pool_ml_queue" not in source
    assert "sfi.stage = 'l1_candidate_seed_after_overlay' AND sfi.decision = 'selected'" in source


def test_recommendation_service_seed_ownership_excludes_strategy_pool_audit_queue():
    source = Path(__file__).resolve().parent.parent.joinpath("services", "recommendation_service.py").read_text(encoding="utf-8")

    assert "strategy_pool_ml_queue" not in source
    assert "sfi.stage = 'l1_candidate_seed_after_overlay' AND sfi.decision = 'selected'" in source


def test_pipeline_keeps_sector_flow_out_of_market_env_fanout():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert 'g.add_edge("load_inputs",         "compute_sector_flow")' not in source
    assert 'g.add_edge("compute_sector_flow", "build_payloads")' not in source
    assert source.index('g.add_edge("write_d1",            "compute_sector_flow")') < source.index(
        'g.add_edge("compute_sector_flow", "export_dataset_snapshot")'
    )
    assert "_load_market_env_with_backoff" in source
    assert "D1_RETRYABLE_MARKERS" in source


def test_build_ml_universe_uses_tradable_screener_rows_without_watchlist():
    from services.payload_builder import build_ml_universe  # noqa: E402

    universe = build_ml_universe([], [{
        "stock_id": 1,
        "symbol": "2330",
        "name": "TSMC",
        "sector": "Semis",
        "market_segment": "LISTED",
        "recommendation_lane": "tradable",
        "eligible_for_ml": 1,
        "eligible_for_pending_buy": 1,
    }])

    assert len(universe) == 1
    assert universe[0]["symbol"] == "2330"
    assert universe[0]["source"] == "daily_recommendations"
    assert universe[0]["recommendation_lane"] == "tradable"
    assert universe[0]["eligible_for_execution"] is True


def test_l2_timesfm_replaces_tree_gate_without_split_target():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "_resolve_coarse_ml_gate_target" not in source
    assert "_attach_l2_core_ml_evidence" not in source
    assert "PIPELINE_L2_L3_SPLIT_ENABLED" not in source
    assert "modal_client.l2_tree_batch_predict" not in source
    assert 'g.add_node("l2_timesfm_enrich"' in source
    assert 'g.add_edge("build_payloads",      "l2_timesfm_enrich")' in source
    assert 'g.add_edge("l2_timesfm_enrich",   "l3_formal_predict")' in source


def test_l2_timesfm_evidence_does_not_truncate_sparse_allocator_pool():
    from services.recommendation_service import apply_l2_timesfm_evidence  # noqa: E402

    recommendations = [
        {"symbol": "2330", "score": 99.0},
        {"symbol": "2317", "score": 98.0},
    ]

    result = apply_l2_timesfm_evidence(recommendations, {}, fallback_size=1)
    assert [row["symbol"] for row in result] == ["2330", "2317"]
    assert all("l2_timesfm_evidence:missing_sidecar" in row["watch_points"] for row in result)

    result = apply_l2_timesfm_evidence(
        recommendations,
        {
            "2330": {
                "stock_meta": {
                    "timesfm_l175_sidecar": {
                        "schema_version": "timesfm-l1-75-sidecar-v1",
                        "layer": "L2",
                        "role": "feature_sidecar",
                        "direct_alpha_blocked": True,
                        "eligible_for_l2_feature_enrichment": True,
                        "l2_feature_input_active": True,
                        "l2_feature_names": ["timesfm_l175_forecast_return"],
                        "current_allowed_use": ["l2_feature_enrichment"],
                        "features": {"forecast_return": 0.012},
                    }
                }
            }
        },
        fallback_size=1,
    )
    assert [row["symbol"] for row in result] == ["2330", "2317"]
    assert result[0]["l2_timesfm_evidence"]["final_recommendation_gate"] is False
    assert result[0]["l2_timesfm_evidence"]["l3_formal_inference_selected"] is True
    assert result[0]["timesfm_sidecar"]["layer"] == "L2"


def test_core_family_evidence_does_not_truncate_when_family_evidence_missing():
    from services.recommendation_service import apply_core_family_evidence  # noqa: E402

    recommendations = [
        {"symbol": "2330", "score": 99.0},
        {"symbol": "2317", "score": 98.0},
    ]

    result = apply_core_family_evidence(
        recommendations,
        {},
        target_size=1,
        strict=False,
        require_lifecycle_weights=True,
    )
    assert [row["symbol"] for row in result] == ["2330", "2317"]
    assert all(row["core_family_evidence"]["selection_role"] == "evidence_only_not_capacity_gate" for row in result)


def test_l3_formal_predict_uses_full_post_l2_timesfm_slate(monkeypatch):
    _install_daily_pipeline_import_stubs()
    from graphs import daily_pipeline_v2  # noqa: E402

    observed_payload_symbols = []

    async def fake_node_ml_predict(state):
        observed_payload_symbols.append([payload["symbol"] for payload in state["payloads"]])
        return {
            "predictions": {
                "2330": {
                    "symbol": "2330",
                    "rank_scores": {"TabM": 0.81, "GNN": 0.76},
                    "ensemble_v2": {"signal": "BUY", "weights": {"TabM": 1.0, "GNN": 1.0}},
                },
                "2317": {
                    "symbol": "2317",
                    "rank_scores": {"TabM": 0.51, "GNN": 0.52},
                    "ensemble_v2": {"signal": "HOLD", "weights": {"TabM": 1.0, "GNN": 1.0}},
                },
            },
            "modal_wait_telemetry": {"stage": "fake_l3"},
        }

    monkeypatch.setattr(daily_pipeline_v2, "node_ml_predict", fake_node_ml_predict)

    state = {
        "payloads": [{"symbol": "2330"}, {"symbol": "2317"}],
        "predictions": {},
    }

    result = asyncio.run(daily_pipeline_v2.node_l3_formal_predict(state))

    assert observed_payload_symbols == [["2330", "2317"]]
    assert result["predictions"]["2330"]["prediction_stage"] == "L3"
    assert result["predictions"]["2317"]["prediction_stage"] == "L3"
    assert result["l3_predictions"]["2330"]["rank_scores"] == {"TabM": 0.81, "GNN": 0.76}
    assert result["l3_predictions"]["2317"]["rank_scores"] == {"TabM": 0.51, "GNN": 0.52}


def test_daily_pipeline_graph_routes_l2_timesfm_before_l3_formal_predict():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert source.index('g.add_edge("build_payloads",      "l2_timesfm_enrich")') < source.index(
        'g.add_edge("l2_timesfm_enrich",   "l3_formal_predict")'
    )
    assert source.index('g.add_edge("l2_timesfm_enrich",   "l3_formal_predict")') < source.index(
        'g.add_edge("l3_formal_predict",   "compute_personas")'
    )
    assert 'g.add_edge("build_payloads",      "ml_predict")' not in source
    assert 'g.add_edge("ml_predict",          "compute_personas")' not in source


def test_daily_pipeline_does_not_inject_gnn_controller_adapter():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "correlation_graph_rank_v1" not in source
    assert "_build_gnn_graph_adapter_scores" not in source


def test_daily_pipeline_does_not_create_alternate_only_prediction_fallback():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "alternate_only_fallback" not in source
    assert "Feature-model fallback" not in source
    assert "feature_missing_no_fallback" in source


def test_daily_pipeline_blocks_degraded_state_space_overlay_rows():
    _install_daily_pipeline_import_stubs()
    from graphs.daily_pipeline_v2 import _state_space_overlay_block_reason  # noqa: E402

    assert _state_space_overlay_block_reason({
        "symbol": "2330",
        "degraded": True,
        "fallback_reason": "svd_not_converged",
    }) == "svd_not_converged"
    assert _state_space_overlay_block_reason({
        "symbol": "2317",
        "degraded": True,
    }) == "degraded_state_space_overlay"
    assert _state_space_overlay_block_reason({
        "symbol": "2454",
        "degraded": False,
        "forecast_pct": 0.01,
    }) is None


def test_daily_pipeline_fails_closed_on_degraded_trading_config_contract():
    _install_daily_pipeline_import_stubs()
    from graphs.daily_pipeline_v2 import _require_trading_config_contract  # noqa: E402

    ok = types.SimpleNamespace(
        contract=types.SimpleNamespace(degraded=False, to_dict=lambda: {"degraded": False})
    )
    _require_trading_config_contract(ok, "recommend")

    degraded = types.SimpleNamespace(
        contract=types.SimpleNamespace(
            degraded=True,
            to_dict=lambda: {"degraded": True, "missing_sections": ["L2_formula"]},
        )
    )
    with pytest.raises(RuntimeError, match="trading_config_contract_degraded:recommend"):
        _require_trading_config_contract(degraded, "recommend")
