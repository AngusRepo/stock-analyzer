from __future__ import annotations

from pathlib import Path

import sys
import types

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.RequestError = RuntimeError
    sys.modules["httpx"] = httpx_stub

from services.payload_builder import build_ml_universe  # noqa: E402


def test_daily_pipeline_refuses_watchlist_screener_fallback():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")
    payload_builder = Path(__file__).resolve().parent.parent.joinpath("services", "payload_builder.py").read_text(encoding="utf-8")

    assert "screener_recs_missing" in source
    assert "refusing watchlist fallback" in source
    assert "build_screener_seed_recommendations(" not in source
    assert "load_active_stocks" not in source
    assert "build_ml_universe([], screener_recs)" in source
    assert "DAILY_RECOMMENDATION_PIPELINE_COLUMNS" in source
    assert "SELECT * FROM daily_recommendations" not in source
    assert "score_components" in payload_builder
    pipeline_columns_start = payload_builder.index("DAILY_RECOMMENDATION_PIPELINE_COLUMNS = (")
    pipeline_columns_end = payload_builder.index(")", pipeline_columns_start)
    pipeline_columns_block = payload_builder[pipeline_columns_start:pipeline_columns_end]
    assert "industry" in pipeline_columns_block
    assert "score_components" in pipeline_columns_block
    for legacy_field in ["chip_score", "tech_score", "momentum_score", "ml_score"]:
        assert legacy_field not in pipeline_columns_block


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
