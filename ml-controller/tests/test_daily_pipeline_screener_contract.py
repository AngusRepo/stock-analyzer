from __future__ import annotations

from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.payload_builder import build_ml_universe  # noqa: E402


def test_daily_pipeline_refuses_watchlist_screener_fallback():
    source = Path(__file__).resolve().parent.parent.joinpath("graphs", "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "screener_recs_missing" in source
    assert "refusing watchlist fallback" in source
    assert "build_screener_seed_recommendations(" not in source
    assert "load_active_stocks" not in source
    assert "build_ml_universe([], screener_recs)" in source


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
