from services.portfolio_allocation_replacement import (
    SPARSE_TANGENT_METHOD,
    apply_sparse_tangent_production_allocation,
    build_historical_replacement_report,
)


def test_apply_sparse_tangent_production_allocation_owns_buy_signals_and_weights():
    rows = [
        {"symbol": "A", "score": 99, "confidence": 0.50, "has_buy_signal": 1, "signal": "BUY"},
        {"symbol": "B", "score": 98, "confidence": 0.50, "has_buy_signal": 1, "signal": "BUY"},
        {
            "symbol": "D",
            "score": 90,
            "confidence": 0.50,
            "has_buy_signal": 0,
            "signal": "HOLD",
            "alpha_allocation": {"selection_rank": 1, "alpha_agent_evo_rank": 3},
        },
    ]
    payloads = [
        {"symbol": "A", "prices": [{"close": v} for v in [100, 120, 90, 125, 95, 130, 100]]},
        {"symbol": "B", "prices": [{"close": v} for v in [100, 101, 102, 103, 104, 105, 106]]},
        {"symbol": "C", "prices": [{"close": v} for v in [100, 102, 104, 106, 108, 110, 112]]},
    ]

    allocated, report = apply_sparse_tangent_production_allocation(
        rows,
        payloads,
        top_k=2,
        selection_pool_size=3,
        min_history_days=4,
        max_weight=0.70,
    )

    selected = [row for row in allocated if row.get("has_buy_signal") == 1]
    assert report["status"] == "production_owner_applied"
    assert all(row["signal_source"] == SPARSE_TANGENT_METHOD for row in selected)
    assert all(row["alpha_allocation"]["method"] == SPARSE_TANGENT_METHOD for row in selected)
    assert sum(row["alpha_allocation"]["portfolio_weight"] for row in selected) == 1.0
    assert len(selected) == 2
    rejected = next(row for row in allocated if row["symbol"] == "D")
    assert rejected["alpha_allocation"]["selected"] is False
    assert rejected["alpha_allocation"]["portfolio_selected"] is False
    assert rejected["alpha_allocation"]["portfolio_selection_rank"] is None
    assert "selection_rank" not in rejected["alpha_allocation"]
    assert rejected["alpha_allocation"]["alpha_agent_evo_rank"] == 3


def test_historical_replacement_report_decides_direct_production_owner():
    recommendation_rows = []
    price_rows = []
    dates = ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07"]
    prices = {
        "A": [100, 90, 81, 73, 66, 60],
        "B": [100, 101, 102, 103, 104, 105],
        "C": [100, 103, 106, 109, 112, 115],
    }
    for symbol, closes in prices.items():
        for date, close in zip(dates, closes):
            price_rows.append({"symbol": symbol, "date": date, "close": close})
    for date in dates[:-1]:
        recommendation_rows.extend([
            {"date": date, "symbol": "A", "score": 99, "expected_return": 0.01},
            {"date": date, "symbol": "B", "score": 98, "expected_return": 0.01},
            {"date": date, "symbol": "C", "score": 90, "expected_return": 0.03},
        ])

    report = build_historical_replacement_report(
        recommendation_rows=recommendation_rows,
        price_rows=price_rows,
        start_date="2026-01-03",
        end_date="2026-01-06",
        top_k=2,
        selection_pool_size=3,
        lookback_days=3,
        min_history_days=2,
        max_weight=0.70,
        min_sharpe_delta=-99,
    )

    assert report["schema_version"] == "portfolio-allocation-production-replacement-v1"
    assert report["decision"]["replace_production_owner"] is True
    assert report["decision"]["production_owner"] == SPARSE_TANGENT_METHOD
