from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.paper_order_ab_service import evaluate_paper_order_ab_rows


def _rows(model: str, active_scores: list[float], challenger_scores: list[float], returns: list[float]) -> list[dict]:
    out: list[dict] = []
    for idx, (active, challenger, ret) in enumerate(zip(active_scores, challenger_scores, returns)):
        out.append({
            "model_name": model,
            "symbol": f"23{idx:02d}",
            "order_date": "2026-04-01",
            "active_score": active,
            "challenger_score": challenger,
            "actual_return_pct": ret,
            "paper_buy_count": 1,
        })
    return out


def test_evaluate_paper_order_ab_rows_passes_when_challenger_orders_rank_better():
    rows = _rows(
        "XGBoost",
        active_scores=[0.7, 0.1, 0.5, 0.2, 0.4],
        challenger_scores=[0.1, 0.3, 0.5, 0.7, 0.9],
        returns=[-0.04, -0.01, 0.00, 0.03, 0.06],
    )

    out = evaluate_paper_order_ab_rows(rows, min_orders=5, min_ic_lift=0.0)

    assert out["XGBoost"]["decision"] == "PASS"
    assert out["XGBoost"]["orders"] == 5
    assert out["XGBoost"]["challenger_order_ic"] > out["XGBoost"]["active_order_ic"]


def test_evaluate_paper_order_ab_rows_fails_when_order_samples_are_insufficient():
    rows = _rows("XGBoost", [0.1, 0.2], [0.2, 0.3], [-0.01, 0.02])

    out = evaluate_paper_order_ab_rows(rows, min_orders=5)

    assert out["XGBoost"]["decision"] == "FAIL"
    assert "paper_order_min_samples" in out["XGBoost"]["failed_gates"]


def test_evaluate_paper_order_ab_rows_fails_when_challenger_does_not_lift_ic():
    rows = _rows(
        "XGBoost",
        active_scores=[0.1, 0.3, 0.5, 0.7, 0.9],
        challenger_scores=[0.5, 0.5, 0.5, 0.5, 0.5],
        returns=[-0.04, -0.01, 0.00, 0.03, 0.06],
    )

    out = evaluate_paper_order_ab_rows(rows, min_orders=5, min_ic_lift=0.0)

    assert out["XGBoost"]["decision"] == "FAIL"
    assert "paper_order_ic_lift" in out["XGBoost"]["failed_gates"]
