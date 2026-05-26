import asyncio

from routers.research_benchmark import (
    ConformalRiskGateRequest,
    research_conformal_risk_gate_dry_run,
)
from services.conformal_risk_gate import build_conformal_risk_gate


def _prediction_rows():
    rows = []
    for idx in range(20):
        dt = f"2026-05-{idx + 1:02d}"
        rows.append({
            "symbol": "2330",
            "label_date": dt,
            "as_of_date": dt,
            "feature_end_date": dt,
            "lower": -0.020,
            "upper": 0.030,
            "kelly_pct": 0.08,
        })
    return rows


def _realized_rows():
    returns = [
        0.010, 0.012, -0.005, 0.004, 0.018,
        -0.010, 0.020, 0.006, -0.015, 0.011,
        0.002, 0.014, -0.018, 0.007, 0.009,
        -0.006, 0.013, -0.012, 0.017, -0.009,
    ]
    return [
        {"symbol": "2330", "label_date": f"2026-05-{idx + 1:02d}", "realized_return": value}
        for idx, value in enumerate(returns)
    ]


def test_conformal_risk_gate_allows_uncertainty_overlay_when_coverage_and_tail_risk_pass():
    report = build_conformal_risk_gate(
        prediction_rows=_prediction_rows(),
        realized_rows=_realized_rows(),
        target_coverage=0.80,
        max_tail_loss_rate=0.10,
        max_cvar_5=0.04,
        min_samples=20,
    )

    assert report["schema_version"] == "conformal-risk-gate-v1"
    assert report["metrics"]["coverage"] == 1.0
    assert report["metrics"]["tail_loss_rate"] == 0.0
    assert report["decision"]["eligible_to_attach_uncertainty_overlay"] is True
    assert report["decision"]["kelly_action"] == "keep_candidate_kelly_cap"
    assert report["decision"]["production_mutation_allowed"] is False


def test_conformal_risk_gate_blocks_future_leakage_and_dampens_kelly():
    predictions = _prediction_rows()
    predictions[5] = {
        **predictions[5],
        "as_of_date": "2026-05-07",
        "feature_end_date": "2026-05-07",
    }
    realized = _realized_rows()
    realized[5] = {**realized[5], "realized_return": -0.12}

    report = build_conformal_risk_gate(
        prediction_rows=predictions,
        realized_rows=realized,
        target_coverage=0.90,
        max_tail_loss_rate=0.05,
        max_cvar_5=0.04,
        min_samples=20,
    )

    assert report["status"] == "blocked"
    assert "future_leakage_detected" in report["blockers"]
    assert report["decision"]["eligible_to_attach_uncertainty_overlay"] is False
    assert report["decision"]["kelly_action"] == "dampen_or_disable_kelly"


def test_conformal_risk_gate_research_route_is_non_mutating():
    response = asyncio.run(research_conformal_risk_gate_dry_run(
        ConformalRiskGateRequest(
            prediction_rows=_prediction_rows(),
            realized_rows=_realized_rows(),
            target_coverage=0.80,
            max_tail_loss_rate=0.10,
            max_cvar_5=0.04,
            min_samples=20,
        )
    ))

    assert response["decision_effect"] == "risk_gate_only"
    assert response["decision"]["production_mutation_allowed"] is False
