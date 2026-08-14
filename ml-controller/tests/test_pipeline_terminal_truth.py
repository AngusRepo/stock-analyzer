from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs.daily_pipeline_v2 import (
    _pipeline_terminal_result,
    classify_pipeline_terminal_errors,
    classify_pipeline_terminal_invariants,
)


def _closed_metrics(**overrides):
    metrics = {
        "prediction_seed_symbols": 5,
        "prediction_symbols": 5,
        "predictions_written": 30,
        "prediction_symbol_closure_passed": True,
        "incomplete_active_model_symbols": 0,
        "recommendation_seed_rows": 5,
        "recommendation_closed_rows": 5,
        "recommendations_updated": 0,
        "sell_marked_non_buy": 5,
        "recommendation_row_closure_passed": True,
    }
    metrics.update(overrides)
    return metrics


def test_pipeline_terminal_allows_only_explicit_advisory_errors():
    classified = classify_pipeline_terminal_errors(["llm_reasons: provider timeout"])
    assert classified == {
        "critical": [],
        "advisory": ["llm_reasons: provider timeout"],
    }
    result = _pipeline_terminal_result(
        {"metrics": _closed_metrics(), "errors": ["llm_reasons: timeout"]},
        run_date="2026-08-14",
        elapsed=2.34,
    )
    assert result["status"] == "completed"
    assert result["critical_errors"] == []


def test_pipeline_terminal_fails_closed_on_unclassified_error():
    result = _pipeline_terminal_result(
        {
            "metrics": _closed_metrics(),
            "errors": ["d1_write: reset stream", "llm_reasons: timeout"],
        },
        run_date="2026-08-14",
        elapsed=1.0,
    )
    assert result["status"] == "error"
    assert result["critical_errors"] == ["d1_write: reset stream"]
    assert result["advisory_errors"] == ["llm_reasons: timeout"]
    assert result["error"] == "d1_write: reset stream"


def test_pipeline_terminal_allows_safe_abstention_when_rows_close():
    result = _pipeline_terminal_result(
        {"metrics": _closed_metrics(recommendations_updated=0), "errors": []},
        run_date="2026-08-14",
        elapsed=1.0,
    )

    assert result["status"] == "completed"
    assert result["terminal_invariant_errors"] == []


def test_pipeline_terminal_fails_when_prediction_symbol_closure_is_false():
    result = _pipeline_terminal_result(
        {
            "metrics": _closed_metrics(
                prediction_symbol_closure_passed=False,
                incomplete_active_model_symbols=2,
            ),
            "errors": [],
        },
        run_date="2026-08-14",
        elapsed=1.0,
    )

    assert result["status"] == "error"
    assert result["terminal_invariant_errors"] == [
        "pipeline_terminal_invariant:prediction_symbol_closure_failed",
        "pipeline_terminal_invariant:active_model_symbol_closure_failed:count=2",
    ]


def test_pipeline_terminal_fails_when_recommendation_rows_do_not_close():
    metrics = _closed_metrics(recommendation_row_closure_passed=False)
    assert classify_pipeline_terminal_invariants(metrics) == [
        "pipeline_terminal_invariant:recommendation_row_closure_failed",
    ]

    result = _pipeline_terminal_result(
        {"metrics": metrics, "errors": []},
        run_date="2026-08-14",
        elapsed=1.0,
    )
    assert result["status"] == "error"


def test_pipeline_terminal_fails_closed_on_missing_or_mismatched_counts():
    metrics = _closed_metrics(
        prediction_symbols=4,
        recommendation_closed_rows=4,
    )
    metrics.pop("incomplete_active_model_symbols")

    blockers = classify_pipeline_terminal_invariants(metrics)

    assert "pipeline_terminal_invariant:prediction_symbol_count_mismatch:actual=4:expected=5" in blockers
    assert "pipeline_terminal_invariant:active_model_symbol_closure_missing" in blockers
    assert "pipeline_terminal_invariant:recommendation_row_count_mismatch:actual=4:expected=5" in blockers
