from __future__ import annotations

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


def test_daily_pipeline_does_not_inject_gnn_controller_adapter():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "correlation_graph_rank_v1" not in source
    assert "_build_gnn_graph_adapter_scores" not in source
