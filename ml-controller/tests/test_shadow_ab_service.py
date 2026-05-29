from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.shadow_ab_service import evaluate_shadow_ab_rows


def _paired_rows(model: str, active_scores: list[float], challenger_scores: list[float], actuals: list[float]) -> list[dict]:
    rows: list[dict] = []
    for idx, (active, challenger, actual) in enumerate(zip(active_scores, challenger_scores, actuals)):
        rows.append({
            "stock_id": idx,
            "sample_date": "2026-04-01",
            "model_name": model,
            "direction_accuracy": active,
            "actual_return_pct": actual,
        })
        rows.append({
            "stock_id": idx,
            "sample_date": "2026-04-01",
            "model_name": f"{model}::challenger",
            "direction_accuracy": challenger,
            "actual_return_pct": actual,
        })
    return rows


def test_evaluate_shadow_ab_rows_passes_when_challenger_ic_beats_active():
    rows = _paired_rows(
        "XGBoost",
        active_scores=[0.5, 0.1, 0.4, 0.2, 0.3],
        challenger_scores=[0.1, 0.3, 0.5, 0.7, 0.9],
        actuals=[-0.04, -0.01, 0.00, 0.03, 0.06],
    )

    out = evaluate_shadow_ab_rows(rows, min_samples=5, min_ic_lift=0.0)

    assert out["XGBoost"]["decision"] == "PASS"
    assert out["XGBoost"]["samples"] == 5
    assert out["XGBoost"]["challenger_ic"] > out["XGBoost"]["active_ic"]


def test_evaluate_shadow_ab_rows_fails_when_samples_are_insufficient():
    rows = _paired_rows(
        "XGBoost",
        active_scores=[0.1, 0.2],
        challenger_scores=[0.2, 0.3],
        actuals=[-0.01, 0.02],
    )

    out = evaluate_shadow_ab_rows(rows, min_samples=5)

    assert out["XGBoost"]["decision"] == "FAIL"
    assert "candidate_min_samples" in out["XGBoost"]["failed_gates"]


def test_evaluate_shadow_ab_rows_fails_when_challenger_ic_does_not_improve():
    rows = _paired_rows(
        "XGBoost",
        active_scores=[0.1, 0.3, 0.5, 0.7, 0.9],
        challenger_scores=[0.5, 0.5, 0.5, 0.5, 0.5],
        actuals=[-0.04, -0.01, 0.00, 0.03, 0.06],
    )

    out = evaluate_shadow_ab_rows(rows, min_samples=5, min_ic_lift=0.0)

    assert out["XGBoost"]["decision"] == "FAIL"
    assert "candidate_ic_lift" in out["XGBoost"]["failed_gates"]
