from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402
from services.recommendation_service import write_predictions_to_d1  # noqa: E402


def test_prediction_writer_requires_feature_version(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)

    def _fake_batch_execute(_statements):
        raise AssertionError("writer must fail before D1 write when feature_version is missing")

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)

    with pytest.raises(ValueError, match="missing_feature_version_contract"):
        write_predictions_to_d1(
            {
                "2330": {
                    "signal": "BUY",
                    "confidence": 0.74,
                    "entry_price": 106.0,
                    "stop_loss": 100.0,
                    "target1": 114.0,
                    "target2": 120.0,
                    "ensemble_v2": {"signal": "BUY", "signal_source": "ensemble_v2"},
                }
            },
            {"2330": 1},
            run_date="2026-06-08",
        )


def test_filtered_recommendations_preserve_screener_seed_rows(monkeypatch):
    captured = {}

    def _fake_batch_execute(statements):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(recommendation_service.d1_client, "batch_execute", _fake_batch_execute)

    written = recommendation_service.delete_filtered_recommendations(["2330", "2317"], "2026-06-08")

    assert written == 2
    for sql, params in captured["statements"]:
        assert "UPDATE daily_recommendations" in sql
        assert "DELETE FROM daily_recommendations" not in sql
        assert "has_buy_signal = 0" in sql
        assert "json_set(" in sql
        assert "json_object(" in sql
        assert "preserved_screener_seed_non_buy" in sql
        assert "ml_filtered_sell_or_no_signal_preserved_seed" in sql
        assert "'$.selected'" in sql
        assert "ml_filter_preserved_non_buy" in sql
        assert "ml_filter:preserved_screener_seed_not_buy" in sql
        assert params[0] == "2026-06-08"
