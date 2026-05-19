from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_backtest_benchmark import (  # noqa: E402
    FINLAB_BACKTEST_BENCHMARK_SCHEMA_VERSION,
    build_finlab_backtest_benchmark_report,
    validate_finlab_backtest_benchmark_report,
)


def _stockvision_backtest() -> dict:
    return {
        "schema_version": "stockvision-backtest-v1",
        "metrics": {
            "annual_return": 0.24,
            "max_drawdown": -0.18,
            "sharpe": 1.42,
            "turnover_ratio": 3.4,
        },
        "reality_report": {
            "schema_version": "backtest-reality-v1",
            "allowed_use": "promotion_candidate",
            "status": "pass",
        },
    }


def _finlab_benchmark() -> dict:
    return {
        "source": "finlab",
        "metrics": {
            "annual_return": 0.21,
            "max_drawdown": -0.20,
            "sharpe": 1.31,
            "turnover_ratio": 3.9,
        },
    }


def test_finlab_backtest_benchmark_is_sanity_check_only():
    report = build_finlab_backtest_benchmark_report(
        _stockvision_backtest(),
        finlab_benchmark=_finlab_benchmark(),
        strategy_id="alpha-v4",
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert report["schema_version"] == FINLAB_BACKTEST_BENCHMARK_SCHEMA_VERSION
    assert report["status"] == "pass"
    assert report["allowed_use"] == "sanity_check_only"
    assert report["decision_effect"] == "benchmark_only"
    assert report["stockvision_backtest_authority"] == "production_truth"
    assert report["finlab_backtest_authority"] == "external_sanity_check"
    assert report["direct_decision_fields"] == []
    assert report["metric_diffs"]["annual_return"]["abs_delta"] == 0.03
    assert validate_finlab_backtest_benchmark_report(report) == []


def test_large_finlab_variance_flags_warning_but_still_cannot_promote_recommendations():
    finlab = _finlab_benchmark()
    finlab["metrics"].update({
        "annual_return": 0.55,
        "max_drawdown": -0.42,
        "sharpe": 2.8,
        "turnover_ratio": 12.5,
    })

    report = build_finlab_backtest_benchmark_report(
        _stockvision_backtest(),
        finlab_benchmark=finlab,
        strategy_id="variance-check",
    )

    assert report["status"] == "warn"
    assert report["allowed_use"] == "sanity_check_only"
    assert report["decision_effect"] == "benchmark_only"
    assert "benchmark_variance_above_tolerance" in report["warnings"]
    assert set(report["variance_flags"]) == {"annual_return", "max_drawdown", "sharpe", "turnover_ratio"}


def test_finlab_decision_or_order_fields_are_quarantined():
    finlab = _finlab_benchmark()
    finlab.update({
        "recommendation_score": 99,
        "buy_signal": True,
        "target_position": 0.2,
        "order_action": "BUY",
    })

    report = build_finlab_backtest_benchmark_report(
        _stockvision_backtest(),
        finlab_benchmark=finlab,
        strategy_id="unsafe-finlab-output",
    )

    assert report["status"] == "blocked"
    assert report["allowed_use"] == "sanity_check_only"
    assert report["decision_effect"] == "benchmark_only"
    assert sorted(report["direct_decision_fields"]) == [
        "buy_signal",
        "order_action",
        "recommendation_score",
        "target_position",
    ]
    assert "direct_decision_fields_present" in report["blocking_reasons"]
    assert validate_finlab_backtest_benchmark_report(report) == []


def test_missing_finlab_benchmark_is_advisory_only():
    report = build_finlab_backtest_benchmark_report(
        _stockvision_backtest(),
        finlab_benchmark=None,
        strategy_id="stockvision-only",
    )

    assert report["status"] == "missing_benchmark"
    assert report["allowed_use"] == "sanity_check_only"
    assert report["decision_effect"] == "benchmark_only"
    assert "finlab_benchmark_missing" in report["warnings"]
    assert report["metric_diffs"] == {}
    assert validate_finlab_backtest_benchmark_report(report) == []


def test_validator_rejects_any_report_that_claims_recommendation_effect():
    report = build_finlab_backtest_benchmark_report(
        _stockvision_backtest(),
        finlab_benchmark=_finlab_benchmark(),
        strategy_id="tampered",
    )
    report["allowed_use"] = "recommendation_input"
    report["decision_effect"] = "score_modifier"

    errors = validate_finlab_backtest_benchmark_report(report)

    assert "allowed_use_must_be_sanity_check_only" in errors
    assert "decision_effect_must_be_benchmark_only" in errors
