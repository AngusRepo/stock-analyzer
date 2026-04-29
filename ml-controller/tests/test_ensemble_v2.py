from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.ensemble_v2 import attach_ensemble_v2  # noqa: E402


def test_ensemble_v2_uses_equal_weight_when_ic_is_cold_start():
    pred = {
        "rank_scores": {
            "XGBoost": 0.74,
            "CatBoost": 0.70,
            "ExtraTrees": 0.66,
        }
    }

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "CatBoost": "active", "ExtraTrees": "active"},
        ic_weights={"XGBoost": 0.0, "CatBoost": 0.0, "ExtraTrees": 0.0},
        degraded_dampening=1.0,
        ev2_cfg={"buyThreshold": 0.70},
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["reason"] == "cold_start_equal_weight"
    assert ev2["weight_total"] == 3.0
    assert ev2["avg_rank"] > 0.69
    assert ev2["signal"] == "BUY"
    assert ev2["contributing_models"] == ["CatBoost", "ExtraTrees", "XGBoost"]


def test_ensemble_v2_keeps_no_positive_weight_when_ic_is_negative():
    pred = {"rank_scores": {"XGBoost": 0.9, "CatBoost": 0.8}}

    attach_ensemble_v2(
        pred,
        model_status={"XGBoost": "active", "CatBoost": "active"},
        ic_weights={"XGBoost": -0.2, "CatBoost": -0.1},
        degraded_dampening=1.0,
    )

    ev2 = pred["ensemble_v2"]
    assert ev2["reason"] == "no_positive_lifecycle_weight"
    assert ev2["signal"] == "HOLD"
    assert ev2["weight_total"] == 0.0
