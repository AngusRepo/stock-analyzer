from __future__ import annotations

import asyncio
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


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


def test_l2_l3_targets_are_proportional_to_upstream_counts():
    from graphs.daily_pipeline_v2 import (  # noqa: E402
        _resolve_coarse_ml_gate_target,
        _resolve_core_family_rank_target,
    )

    trading_config = {"screener": {"coarseMlKeepRatio": 0.75, "coreFamilyKeepRatio": 0.75}}
    sizing = {"core_family_rank_size": 80}

    l2_target = _resolve_coarse_ml_gate_target(70, sizing, trading_config)
    l3_target = _resolve_core_family_rank_target(l2_target, sizing, trading_config)

    assert l2_target == 53
    assert l3_target == 40


def test_l2_core_gate_selects_by_tree_rank_only():
    from graphs.daily_pipeline_v2 import _attach_l2_core_ml_gate  # noqa: E402

    predictions = {
        "2330": {"rank_scores": {"LightGBM": 0.80, "XGBoost": 0.70, "ExtraTrees": 0.90, "TabM": 0.10}},
        "2317": {"rank_scores": {"LightGBM": 0.40, "XGBoost": 0.50, "ExtraTrees": 0.45, "TabM": 0.99}},
        "2454": {"rank_scores": {"TabM": 1.00}},
    }

    gated, selected, summary = _attach_l2_core_ml_gate(
        predictions,
        target_size=1,
        upstream_count=3,
    )

    assert selected == ["2330"]
    assert gated["2330"]["core_ml_gate"]["selected"] is True
    assert gated["2317"]["core_ml_gate"]["selected"] is False
    assert gated["2454"]["core_ml_gate"]["selected"] is False
    assert gated["2330"]["core_ml_gate"]["models"] == ["LightGBM", "XGBoost", "ExtraTrees"]
    assert summary["scored_count"] == 2


def test_l3_formal_predict_uses_only_l2_shortlist_and_preserves_l2_gate(monkeypatch):
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
            },
            "modal_wait_telemetry": {"stage": "fake_l3"},
        }

    monkeypatch.setattr(daily_pipeline_v2, "node_ml_predict", fake_node_ml_predict)

    state = {
        "payloads": [{"symbol": "2330"}, {"symbol": "2317"}],
        "l3_payloads": [{"symbol": "2330"}],
        "l2_predictions": {
            "2330": {
                "symbol": "2330",
                "rank_scores": {"LightGBM": 0.8, "XGBoost": 0.7, "ExtraTrees": 0.9},
                "core_ml_gate": {"selected": True, "rank": 1, "target_size": 1},
                "feature_version": "l2_tree_predict_v1",
                "prediction_stage": "L2",
            },
            "2317": {
                "symbol": "2317",
                "rank_scores": {"LightGBM": 0.4, "XGBoost": 0.5, "ExtraTrees": 0.45},
                "core_ml_gate": {"selected": False, "rank": 2, "target_size": 1},
                "feature_version": "l2_tree_predict_v1",
                "prediction_stage": "L2",
            },
        },
    }

    result = asyncio.run(daily_pipeline_v2.node_l3_formal_predict(state))

    assert observed_payload_symbols == [["2330"]]
    assert result["predictions"]["2330"]["prediction_stage"] == "L3"
    assert result["predictions"]["2330"]["core_ml_gate"] == {"selected": True, "rank": 1, "target_size": 1}
    assert result["predictions"]["2330"]["feature_version"] == "l2_tree_predict_v1"
    assert result["predictions"]["2317"]["prediction_stage"] == "L2"
    assert result["predictions"]["2317"]["feature_version"] == "l2_tree_predict_v1"
    assert result["l3_predictions"]["2330"]["rank_scores"] == {"TabM": 0.81, "GNN": 0.76}


def test_daily_pipeline_graph_splits_l2_gate_before_l3_formal_predict():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "def _l2_l3_split_enabled" in source
    assert "PIPELINE_L2_L3_SPLIT_ENABLED" in source
    assert source.index('g.add_edge("build_payloads",      "l2_cheap_ml_predict")') < source.index(
        'g.add_edge("l2_cheap_ml_predict", "l2_core_gate")'
    )
    assert source.index('g.add_edge("l2_cheap_ml_predict", "l2_core_gate")') < source.index(
        'g.add_edge("l2_core_gate",        "l3_formal_predict")'
    )
    assert source.index('g.add_edge("l2_core_gate",        "l3_formal_predict")') < source.index(
        'g.add_edge("l3_formal_predict",   "compute_personas")'
    )
    assert 'g.add_edge("build_payloads",      "ml_predict")' in source
    assert 'g.add_edge("ml_predict",          "compute_personas")' in source


def test_daily_pipeline_does_not_inject_gnn_controller_adapter():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "correlation_graph_rank_v1" not in source
    assert "_build_gnn_graph_adapter_scores" not in source
