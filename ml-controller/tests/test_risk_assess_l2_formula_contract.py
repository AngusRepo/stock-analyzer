from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers.risk import (  # noqa: E402
    AccuracyData,
    AdaptiveConfigData,
    MarketData,
    RiskAssessRequest,
    TradingData,
    post_risk_assess,
)
import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402


def test_risk_assess_consumes_worker_l2_formula():
    response = post_risk_assess(
        RiskAssessRequest(
            date="2026-06-08",
            market=MarketData(risk_score=80, risk_level="red"),
            accuracy=AccuracyData(global_30d=0.50, rows_30d=[], rows_90d=[]),
            trading=TradingData(losses_5d=3, total_5d=4),
            adaptive_config=AdaptiveConfigData(
                L2_formula={
                    "confidence_risk_mult": 0.01,
                    "confidence_perf_mult": 0.01,
                    "confidence_delta_clip_lo": -0.03,
                    "confidence_delta_clip_hi": 0.04,
                    "confidence_effective_clip_lo": 0.40,
                    "confidence_effective_clip_hi": 0.70,
                    "sltp_add_red_sl": 0.77,
                    "sltp_add_red_tp": 0.66,
                    "bandit_loss_thresh_high": 0.90,
                    "bandit_loss_thresh_med": 0.20,
                    "bandit_max_mult_high": 1.10,
                    "bandit_max_mult_med": 1.40,
                    "bandit_max_mult_low": 2.40,
                },
                baseline_buy_signal_score=0.50,
            ),
        )
    )

    params = response["adaptive_params"]
    assert params["provenance"]["l2_formula_source"] == "worker_trading_config"
    assert params["sltp_add"] == {"sl_add": 0.77, "tp_add": 0.66}
    assert params["bandit_max_mult"] == 1.4
    assert params["bandit_context"]["decision"] == "medium_recent_loss_rate_cap_exposure"
    assert params["threshold_components"]["effective_delta"] <= 0.04


def test_risk_assess_preserves_ga_optimizer_adaptive_context():
    response = post_risk_assess(
        RiskAssessRequest(
            date="2026-06-22",
            market=MarketData(risk_score=30, risk_level="green"),
            accuracy=AccuracyData(global_30d=0.60, rows_30d=[], rows_90d=[]),
            trading=TradingData(losses_5d=0, total_5d=2),
            adaptive_config=AdaptiveConfigData(
                L2_formula={"bandit_max_mult_low": 2.4},
                baseline_buy_signal_score=0.50,
                ga_optimizer={
                    "source": "optimizer:ga:latest",
                    "status": "approved",
                    "runtime_role": "approved_limited_production_meta_policy_context",
                    "applies_to_trading_config": False,
                    "promotion": {"level": "L3", "next_level": "L4"},
                    "effect_policy": {
                        "enabled": True,
                        "scope": "limited_capped_meta_policy_context",
                        "max_bandit_max_mult": 1.25,
                        "mutates_trading_config": False,
                    },
                },
            ),
        )
    )

    ga = response["adaptive_params"]["bandit_context"]["ga_optimizer"]
    assert ga["source"] == "optimizer:ga:latest"
    assert ga["promotion"]["level"] == "L3"
    assert ga["applies_to_trading_config"] is False
    assert response["adaptive_params"]["bandit_max_mult"] == 1.25
    assert ga["applied_effect"]["applied"] is True
    assert ga["applied_effect"]["reason"] == "approved_l3_capped_bandit_effect"
    assert ga["applied_effect"]["mutates_trading_config"] is False


def test_risk_assess_confidence_hook_uses_active_9_only():
    response = post_risk_assess(
        RiskAssessRequest(
            date="2026-06-08",
            market=MarketData(risk_score=0, risk_level="green"),
            accuracy=AccuracyData(
                global_30d=0.50,
                rows_30d=[
                    {"model_name": "LightGBM", "total_count": 100, "accuracy": 0.80, "profit_factor": 1.30},
                    {"model_name": "XGBoost", "total_count": 100, "accuracy": 0.60, "profit_factor": 1.10},
                    {"model_name": "CatBoost", "total_count": 1000, "accuracy": 0.10, "profit_factor": 0.10},
                ],
                rows_90d=[
                    {"model_name": "LightGBM", "total_count": 300, "accuracy": 0.70, "profit_factor": 1.20},
                    {"model_name": "CatBoost", "total_count": 3000, "accuracy": 0.10, "profit_factor": 0.10},
                ],
            ),
            trading=TradingData(losses_5d=0, total_5d=0),
            adaptive_config=AdaptiveConfigData(
                L2_formula={
                    "confidence_target_accuracy": 0.70,
                    "confidence_perf_mult": 0.20,
                    "confidence_risk_mult": 0.0,
                },
                baseline_buy_signal_score=0.50,
            ),
        )
    )

    params = response["adaptive_params"]
    hook = params["ml_confidence_hook"]
    assert hook["status"] == "active_9_rows_quality"
    assert hook["model_quality_30d"] == 0.70
    assert hook["sample_count_30d"] == 200
    assert hook["active_model_count_30d"] == 2
    assert hook["ignored_non_active_models"] == ["CatBoost"]
    assert params["threshold_components"]["inputs"]["model_quality"] == 0.70
    assert "CatBoost" not in params["pf_quality_mult"]


def test_risk_assess_requires_worker_l2_formula_contract():
    with pytest.raises(HTTPException, match="L2_formula"):
        post_risk_assess(
            RiskAssessRequest(
                date="2026-06-08",
                market=MarketData(risk_score=50, risk_level="yellow"),
                accuracy=AccuracyData(global_30d=0.55),
                trading=TradingData(losses_5d=0, total_5d=0),
                adaptive_config=AdaptiveConfigData(),
            )
        )
