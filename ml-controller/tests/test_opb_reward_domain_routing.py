from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402


def test_opb_reward_ledger_reads_core_and_learning_owners(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []
    allocation = json.dumps({
        "selected": True,
        "allocation_weight": 1.0,
        "opb_controller": {
            "enabled": True,
            "selected_arm": {"arm_id": "diversified_alpha"},
        },
    })

    def core_query(sql, params, timeout=30.0):
        calls.append(("core", sql))
        assert params == ["2026-06-09", "2026-07-09", 5000]
        return [{
            "date": "2026-07-01", "stock_id": 1, "symbol": "AAA", "rank": 1,
            "alpha_allocation": allocation,
        }]

    def learning_labels_query(sql, params, timeout=30.0):
        calls.append(("learning_labels", sql))
        assert params[-1] == recommendation_service.PRICE_HORIZON_PROJECTION_VERSION
        return [{
            "stock_id": 1, "price_date": "2026-07-01", "entry_date": "2026-07-02",
            "entry_raw_open": 100.0, "entry_adjustment_factor": 1.0,
            "exit_date": "2026-07-08", "exit_raw_close": 110.0,
            "exit_adjustment_factor": 1.0, "outcome_known_date": "2026-07-08",
        }]

    def predictions_query(sql, params, timeout=30.0):
        calls.append(("predictions", sql))
        assert params == [1, "2026-07-01", "2026-07-02"]
        return [{
            "stock_id": 1, "prediction_date": "2026-07-01", "trade_pnl_pct": None,
            "trade_pnl_r": None, "verified_at": None, "verification_label_known_date": None,
        }]

    class Client:
        def __init__(self, query):
            self.query = query

    monkeypatch.setattr(recommendation_service, "CORE_D1_CLIENT", Client(core_query))
    monkeypatch.setattr(
        recommendation_service,
        "LEARNING_LABELS_D1_CLIENT",
        Client(learning_labels_query),
    )
    monkeypatch.setattr(recommendation_service, "PREDICTIONS_D1_CLIENT", Client(predictions_query))
    ledger = recommendation_service.load_online_portfolio_bandit_reward_ledger(
        as_of_date="2026-07-09", lookback_days=30,
    )

    assert [domain for domain, _sql in calls] == ["core", "learning_labels", "predictions"]
    assert "FROM daily_recommendations" in calls[0][1]
    assert "price_horizon_labels_v1" in calls[1][1]
    assert "FROM predictions" in calls[2][1]
    assert ledger[0]["arm_id"] == "diversified_alpha"
    assert ledger[0]["reward_mean"] == pytest.approx(0.0982)


def test_opb_canonical_loader_keeps_each_d1_query_under_bind_limit(monkeypatch) -> None:
    recommendation_rows = [
        {"date": "2026-07-01", "stock_id": stock_id, "symbol": str(stock_id),
         "rank": stock_id, "alpha_allocation": "{}"}
        for stock_id in range(1, 82)
    ]
    observed_learning_label_binds: list[int] = []
    observed_learning_binds: list[int] = []
    class Client:
        def __init__(self, query):
            self.query = query


    def learning_labels_query(sql, params, timeout=30.0):
        observed_learning_label_binds.append(len(params))
        return []

    def learning_query(sql, params, timeout=30.0):
        observed_learning_binds.append(len(params))
        return []

    monkeypatch.setattr(
        recommendation_service,
        "CORE_D1_CLIENT",
        Client(lambda *args, **kwargs: recommendation_rows),
    )
    monkeypatch.setattr(
        recommendation_service,
        "LEARNING_LABELS_D1_CLIENT",
        Client(learning_labels_query),
    )
    monkeypatch.setattr(recommendation_service, "PREDICTIONS_D1_CLIENT", Client(learning_query))
    assert recommendation_service._load_canonical_opb_reward_rows(
        cutoff="2026-06-01", knowledge_date="2026-07-09", max_rows=5000,
    ) == []
    assert observed_learning_label_binds == [81, 81, 3]
    assert observed_learning_binds == []
    assert max(observed_learning_label_binds) <= 100


def test_opb_canonical_reward_does_not_require_ensemble_prediction(monkeypatch) -> None:
    allocation = json.dumps({
        "selected": True,
        "allocation_weight": 1.0,
        "opb_controller": {
            "enabled": True,
            "selected_arm": {"arm_id": "liquidity_diversified"},
        },
    })

    class Client:
        def __init__(self, query):
            self.query = query

    monkeypatch.setattr(
        recommendation_service,
        "CORE_D1_CLIENT",
        Client(lambda *_args, **_kwargs: [{
            "date": "2026-08-24",
            "stock_id": 1,
            "symbol": "AAA",
            "rank": 1,
            "alpha_allocation": allocation,
        }]),
    )
    monkeypatch.setattr(
        recommendation_service,
        "LEARNING_LABELS_D1_CLIENT",
        Client(lambda *_args, **_kwargs: [{
            "stock_id": 1,
            "price_date": "2026-08-24",
            "entry_date": "2026-08-25",
            "entry_raw_open": 100.0,
            "entry_adjustment_factor": 1.0,
            "exit_date": "2026-08-31",
            "exit_raw_close": 105.0,
            "exit_adjustment_factor": 1.0,
            "outcome_known_date": "2026-08-31",
        }]),
    )
    monkeypatch.setattr(
        recommendation_service,
        "PREDICTIONS_D1_CLIENT",
        Client(lambda *_args, **_kwargs: []),
    )

    ledger = recommendation_service.load_online_portfolio_bandit_reward_ledger(
        as_of_date="2026-09-01",
        lookback_days=30,
    )

    assert len(ledger) == 1
    assert ledger[0]["arm_id"] == "liquidity_diversified"
    assert ledger[0]["reward_mean"] == pytest.approx(0.0482)
    assert ledger[0]["reward_source_counts"] == {
        "canonical_adjusted_five_session_selection_return_net_cost": 1,
    }
