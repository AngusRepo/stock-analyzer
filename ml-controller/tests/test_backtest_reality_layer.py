from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_reality_layer import (  # noqa: E402
    BACKTEST_REALITY_SCHEMA_VERSION,
    build_backtest_reality_report,
    validate_backtest_reality_report,
)


def _healthy_metrics() -> dict:
    return {
        "avg_daily_turnover_twd": 85_000_000,
        "target_order_value_twd": 2_000_000,
        "max_order_participation_pct": 0.0235,
        "estimated_slippage_bps": 12,
        "estimated_fee_tax_bps": 32,
        "limit_lock_touch_pct": 0.004,
        "disposition_event_count": 0,
        "full_delivery_trade_count": 0,
        "mae_p95_pct": -0.075,
        "mfe_p50_pct": 0.082,
        "turnover_ratio": 3.2,
        "walk_forward": {"passed": True, "windows": 8, "oos_sharpe": 1.18},
    }


def test_reality_report_passes_when_tradability_evidence_is_complete():
    report = build_backtest_reality_report(
        _healthy_metrics(),
        strategy_id="alpha-v4",
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert report["schema_version"] == BACKTEST_REALITY_SCHEMA_VERSION
    assert report["status"] == "pass"
    assert report["allowed_use"] == "promotion_candidate"
    assert report["failed_gates"] == []
    assert report["capacity"]["participation_pct"] == 0.0235
    assert report["transaction_cost"]["total_bps"] == 44.0
    assert validate_backtest_reality_report(report) == []


def test_reality_report_fails_on_capacity_cost_and_restricted_market_events():
    metrics = _healthy_metrics()
    metrics.update({
        "avg_daily_turnover_twd": 12_000_000,
        "target_order_value_twd": 2_000_000,
        "max_order_participation_pct": 0.1667,
        "estimated_slippage_bps": 55,
        "estimated_fee_tax_bps": 70,
        "limit_lock_touch_pct": 0.06,
        "disposition_event_count": 2,
        "full_delivery_trade_count": 1,
    })

    report = build_backtest_reality_report(metrics, strategy_id="fragile")

    assert report["status"] == "fail"
    assert report["allowed_use"] == "research_only"
    assert "liquidity" in report["failed_gates"]
    assert "capacity" in report["failed_gates"]
    assert "transaction_cost" in report["failed_gates"]
    assert "limit_lock" in report["failed_gates"]
    assert "disposition" in report["failed_gates"]
    assert "full_delivery" in report["failed_gates"]


def test_reality_report_fails_when_mae_mfe_turnover_or_walk_forward_are_missing_or_bad():
    metrics = _healthy_metrics()
    metrics.update({
        "mae_p95_pct": -0.18,
        "mfe_p50_pct": 0.04,
        "turnover_ratio": 11.5,
        "walk_forward": {"passed": False, "windows": 2},
    })

    report = build_backtest_reality_report(metrics, strategy_id="overfit-fast-turnover")

    assert report["status"] == "fail"
    assert "mae_mfe" in report["failed_gates"]
    assert "turnover" in report["failed_gates"]
    assert "walk_forward" in report["failed_gates"]
    assert report["mae_mfe"]["mfe_to_abs_mae_ratio"] < 0.8


def test_reality_report_fails_closed_when_required_metrics_are_missing():
    report = build_backtest_reality_report({}, strategy_id="missing-reality")

    assert report["status"] == "fail"
    assert report["allowed_use"] == "research_only"
    assert set(report["failed_gates"]) >= {
        "liquidity",
        "capacity",
        "transaction_cost",
        "mae_mfe",
        "walk_forward",
    }
    assert validate_backtest_reality_report(report) == []
