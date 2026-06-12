from __future__ import annotations

from services.adaptive import compute_adaptive_params
from services.adaptive import compute_confidence_components
from services import payload_builder


def test_adaptive_params_expose_p8_governance_metadata():
    params = compute_adaptive_params(
        risk_score=72,
        risk_level="orange",
        accuracy_30d=0.54,
        rows_30d=[],
        rows_90d=[],
        losses_5d=2,
        total_5d=4,
        current_version=3,
    )

    provenance = params["provenance"]
    assert provenance["owner"] == "ml-controller"
    assert provenance["source"] == "risk-assess"
    assert provenance["l2_formula_source"] == "controller_fallback_defaults"
    assert provenance["update_frequency"] == "daily_after_verify"
    assert provenance["fallback"] is False

    assert set(params["regime_overrides"]) == {"bull", "bear", "volatile", "sideways"}
    assert params["threshold_components"]["formula"].startswith("risk_penalty")
    assert params["regime_overrides"]["volatile"]["confidence_delta"] >= params["confidence_delta"]
    assert "threshold_components" in params["regime_overrides"]["bull"]
    assert params["bandit_context"]["reward_ledger"] == "paper_orders.sell_5d"
    assert params["bandit_context"]["decision"] in {
        "high_recent_loss_rate_force_explore",
        "medium_recent_loss_rate_cap_exposure",
        "reward_ledger_ok",
        "no_recent_reward_samples",
    }

    meta = params["meta_layer"]
    assert meta["alpha_vote_models"] == [
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
        "TimesFM",
    ]
    assert meta["state_space_overlays"] == ["KalmanFilter", "MarkovSwitching"]
    assert meta["meta_optimizers"] == ["GAOptimizer"]
    for component in ["ARF", "LinUCB", "Conformal", "Stacking", "GAOptimizer", "NeuralUCB", "NeuralTS", "OnlinePortfolioBandit", "NeuCB"]:
        assert component in meta["adaptive_components"]
    assert "circuit" not in params
    assert "alphaFramework" not in params


def test_bull_low_vol_high_trend_can_lower_threshold_delta():
    components = compute_confidence_components(
        risk_score=19,
        accuracy_30d=0.56,
        risk_level="green",
        regime="bull_market",
        trend_quality=0.85,
        volatility_score=0.20,
    )

    assert components["effective_delta"] < 0
    assert components["regime_opportunity_credit"] > 0
    assert components["trend_quality_credit"] > 0


def test_bull_high_vol_or_poor_model_quality_does_not_lower_threshold():
    components = compute_confidence_components(
        risk_score=55,
        accuracy_30d=0.43,
        risk_level="orange",
        regime="bull_market",
        trend_quality=0.80,
        volatility_score=0.72,
    )

    assert components["effective_delta"] > 0
    assert components["regime_opportunity_credit"] == 0


def test_cloud_run_payload_builder_resolves_regime_adaptive_params(monkeypatch):
    def fake_get_json(key, default=None, timeout=30.0):
        if key == "ml:adaptive_params":
            return {
                "confidence_delta": 0.01,
                "bandit_max_mult": 2.5,
                "regime_overrides": {
                    "volatile": {
                        "confidence_delta": 0.08,
                        "bandit_max_mult": 1.5,
                        "screener": {"ml_shortlist_delta": 8},
                    }
                },
                "provenance": {"source": "risk-assess"},
            }
        if key == "ml:regime:meta":
            return {"label": "volatile"}
        return default

    monkeypatch.setattr(payload_builder.kv_client, "get_json", fake_get_json)
    monkeypatch.setattr(payload_builder.kv_client, "get", lambda *_args, **_kwargs: None)

    params = payload_builder.load_effective_adaptive_params()

    assert params["confidence_delta"] == 0.08
    assert params["bandit_max_mult"] == 1.5
    assert params["screener"]["ml_shortlist_delta"] == 8
    assert params["provenance"]["regime"] == "volatile"
