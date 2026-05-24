from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import d1_client  # noqa: E402
from services.backtest_engine import MLPredictionsCache  # noqa: E402


def test_mode_b_prediction_cache_uses_live_recommendation_confidence_first(monkeypatch):
    captured: dict[str, object] = {}

    def fake_query(sql: str, params: list[object]):
        captured["sql"] = sql
        captured["params"] = params
        return [
            {
                "symbol": "2330",
                "d": "2026-05-22",
                "recommendation_conf": 0.71,
                "legacy_conf": 0.05,
                "trade_signal": "hold",
                "forecast_data": json.dumps({"ensemble_v2": {"confidence": 0.63}}),
            },
            {
                "symbol": "2317",
                "d": "2026-05-22",
                "recommendation_conf": None,
                "legacy_conf": 0.04,
                "trade_signal": "hold",
                "forecast_data": json.dumps({"ensemble_v2": {"confidence": 0.64}}),
            },
            {
                "symbol": "2454",
                "d": "2026-05-22",
                "recommendation_conf": None,
                "legacy_conf": 0.58,
                "trade_signal": "hold",
                "forecast_data": "{}",
            },
        ]

    monkeypatch.setattr(d1_client, "query", fake_query)

    cache = MLPredictionsCache.load_from_d1("2026-05-01", "2026-05-22")

    assert cache.get("2330", "2026-05-22") == 0.71
    assert cache.get("2317", "2026-05-22") == 0.64
    assert cache.get("2454", "2026-05-22") == 0.58
    assert "daily_recommendations" in str(captured["sql"])
    assert cache.diagnostics()["source_counts"] == {
        "daily_recommendations.confidence": 1,
        "forecast_data.ensemble_v2.confidence": 1,
        "predictions.direction_accuracy_legacy": 1,
    }
