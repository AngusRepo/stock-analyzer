from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402
from services.recommendation_service import write_predictions_to_d1  # noqa: E402
def test_prediction_writer_routes_learning_domain():
    assert recommendation_service.PREDICTIONS_D1_CLIENT.domain.value == "learning"




def test_prediction_writer_requires_feature_version(monkeypatch):

    def _fake_batch_execute(_statements):
        raise AssertionError("writer must fail before D1 write when feature_version is missing")

    monkeypatch.setattr(recommendation_service, "_predictions_batch_execute", _fake_batch_execute)

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

    monkeypatch.setattr(recommendation_service.CORE_D1_CLIENT, "batch_execute", _fake_batch_execute)

    written = recommendation_service.delete_filtered_recommendations(
        ["2330", "2317"],
        "2026-06-08",
        filtered_diagnostics={
            "2330": {
                "filtered_signal": "SELL",
                "sparse_decision_coverage": False,
            }
        },
    )

    assert written == 2
    for sql, params in captured["statements"]:
        assert "UPDATE daily_recommendations" in sql
        assert "DELETE FROM daily_recommendations" not in sql
        assert "has_buy_signal = 0" in sql
        assert "json_object(" in sql
        assert "alpha_allocation = json(?)" in sql
        assert "json_set(" not in sql
        assert "'s12_trade_ev'" not in sql
        assert "ml_filter:preserved_screener_seed_not_buy" in sql
        allocation = json.loads(params[0])
        diagnostic = allocation["allocator_ev_fusion_diagnostic"]
        assert allocation["selection_reason"] == "preserved_screener_seed_non_buy"
        assert allocation["expected_return_source"] == "ml_filtered_sell_or_no_signal_preserved_seed"
        assert allocation["expected_return_owner"] == "risk_abstention"
        assert allocation["allocator_edge_resolver"]["abstention"] is True
        assert allocation["expected_return_abstention"]["candidate_contract"] == "explicit_no_trade_abstention"
        assert diagnostic["status"] == "not_evaluated"
        assert diagnostic["reason"] == "ml_filter_preserved_non_buy"
        if params[2] == "2330":
            assert diagnostic["filtered_signal"] == "SELL"
            assert diagnostic["sparse_decision_coverage"] is False
        assert params[1] == "2026-06-08"
