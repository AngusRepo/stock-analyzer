from __future__ import annotations

from services.ensemble_v2 import attach_ensemble_v2


def test_attach_ensemble_v2_holds_when_all_lifecycle_weights_are_zero():
    pred = {
        "rank_scores": {
            "XGBoost": 0.95,
            "CatBoost": 0.92,
        },
        "chronos": {"forecast_pct": 0.04},
    }

    attach_ensemble_v2(
        pred,
        model_status={
            "XGBoost": "active",
            "CatBoost": "retired",
            "Chronos": "active",
        },
        ic_weights={
            "XGBoost": -0.02,
            "CatBoost": 0.30,
            "Chronos": 0.0,
        },
        degraded_dampening=0.5,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["signal"] == "HOLD"
    assert ev2["avg_rank"] == 0.5
    assert ev2["contributing_models"] == []
    assert ev2["weight_total"] == 0.0
    assert ev2["reason"] == "no_positive_lifecycle_weight"


def test_attach_ensemble_v2_can_use_alternate_models_when_feature_models_fail():
    pred = {
        "rank_scores": {},
        "chronos": {"forecast_pct": 0.04},
        "kalman_filter": {"forecast_pct": 0.03},
    }

    attach_ensemble_v2(
        pred,
        model_status={"Chronos": "active", "KalmanFilter": "active"},
        ic_weights={"Chronos": 0.03, "KalmanFilter": 0.02},
        degraded_dampening=1.0,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["avg_rank"] > 0.5
    assert ev2["contributing_models"] == ["Chronos", "KalmanFilter"]
    assert ev2["weight_total"] > 0


def test_daily_pipeline_wrapper_no_longer_contains_legacy_plain_mean_body():
    from pathlib import Path

    source = Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py"
    text = source.read_text(encoding="utf-8")
    start = text.index("def _attach_ensemble_v2(")
    end = text.index("async def node_compute_personas", start)
    body = text[start:end]

    assert "attach_ensemble_v2(pred, model_status, ic_weights, degraded_dampening, ev2_cfg)" in body
    assert "plain mean" not in body
    assert "weight_total > 0" not in body
