import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.signature_informed_allocation import (
    SIT_METHOD,
    allocate_signature_informed_transformer,
    apply_signature_informed_production_allocation,
    build_historical_sit_vs_sparse_report,
)


def test_signature_informed_allocator_outputs_capped_weights():
    candidates = [
        {"symbol": "A", "score": 95, "expected_return": 0.02},
        {"symbol": "B", "score": 90, "expected_return": 0.015},
        {"symbol": "C", "score": 85, "expected_return": 0.012},
    ]
    history = {
        "A": [0.01, 0.012, 0.009, 0.011, 0.010, 0.013],
        "B": [0.004, 0.003, 0.005, 0.003, 0.004, 0.005],
        "C": [0.02, -0.08, 0.02, -0.06, 0.01, -0.05],
    }

    weights = allocate_signature_informed_transformer(
        candidates,
        history,
        top_k=2,
        max_weight=0.60,
        selection_pool_size=3,
    )

    assert set(weights).issubset({"A", "B", "C"})
    assert len(weights) == 2
    assert round(sum(weights.values()), 8) == 1.0
    assert max(weights.values()) <= 0.60


def test_apply_signature_informed_allocation_owns_final_weights():
    rows = [
        {"symbol": "A", "score": 95, "confidence": 0.50, "signal": "HOLD", "has_buy_signal": 0},
        {"symbol": "B", "score": 90, "confidence": 0.50, "signal": "HOLD", "has_buy_signal": 0},
        {"symbol": "C", "score": 70, "confidence": 0.50, "signal": "BUY", "has_buy_signal": 1, "alpha_allocation": {"selection_rank": 1}},
    ]
    payloads = [
        {"symbol": "A", "prices": [{"close": value} for value in [100, 101, 102, 103, 104, 105, 106]]},
        {"symbol": "B", "prices": [{"close": value} for value in [100, 100.5, 101, 101.5, 102, 102.5, 103]]},
        {"symbol": "C", "prices": [{"close": value} for value in [100, 98, 96, 94, 92, 90, 88]]},
    ]

    allocated, report = apply_signature_informed_production_allocation(
        rows,
        payloads,
        top_k=2,
        selection_pool_size=3,
        min_history_days=4,
        max_weight=0.60,
    )

    selected = [row for row in allocated if row.get("has_buy_signal") == 1]
    assert report["status"] == "production_owner_applied"
    assert report["method"] == SIT_METHOD
    assert len(selected) == 2
    assert all(row["signal_source"] == SIT_METHOD for row in selected)
    assert all(row["alpha_allocation"]["portfolio_selected"] is True for row in selected)
    rejected = next(row for row in allocated if row["symbol"] == "C")
    assert rejected["alpha_allocation"]["portfolio_selection_rank"] is None
    assert "selection_rank" not in rejected["alpha_allocation"]


def test_historical_sit_vs_sparse_report_compares_same_replay_dates():
    dates = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06"]
    prices = {
        "A": [100, 101, 102, 103, 104, 105],
        "B": [100, 100.4, 100.8, 101.2, 101.6, 102],
        "C": [100, 97, 99, 96, 98, 95],
    }
    price_rows = [
        {"symbol": symbol, "date": date, "close": close}
        for symbol, closes in prices.items()
        for date, close in zip(dates, closes)
    ]
    recommendation_rows = [
        {"date": date, "symbol": symbol, "score": 90 - idx, "expected_return": 0.01}
        for date in dates[:-1]
        for idx, symbol in enumerate(["A", "B", "C"])
    ]

    report = build_historical_sit_vs_sparse_report(
        recommendation_rows=recommendation_rows,
        price_rows=price_rows,
        start_date="2026-05-02",
        end_date="2026-05-05",
        top_k=2,
        selection_pool_size=3,
        lookback_days=3,
        min_history_days=1,
    )

    assert report["schema_version"] == "signature-informed-allocation-v1"
    assert report["sparse_tangent"]["owner"] == "sparse_tangent_inverse_risk"
    assert report["signature_informed_transformer"]["owner"] == SIT_METHOD
    assert report["decision"]["historical_replay_days"] > 0
