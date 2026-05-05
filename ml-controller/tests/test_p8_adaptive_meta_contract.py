from __future__ import annotations

from services.adaptive import compute_adaptive_params
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
    assert provenance["update_frequency"] == "daily_after_verify"
    assert provenance["fallback"] is False

    assert set(params["regime_overrides"]) == {"bull", "bear", "volatile", "sideways"}
    assert params["regime_overrides"]["bull"]["confidence_delta"] < params["confidence_delta"]
    assert params["regime_overrides"]["volatile"]["confidence_delta"] > params["confidence_delta"]

    meta = params["meta_layer"]
    assert meta["alpha_vote_models"] == [
        "XGBoost",
        "CatBoost",
        "ExtraTrees",
        "LightGBM",
        "FT-Transformer",
        "Chronos",
        "DLinear",
        "PatchTST",
    ]
    assert meta["state_space_overlays"] == ["KalmanFilter", "MarkovSwitching"]
    assert meta["meta_optimizers"] == ["GAOptimizer"]
    for component in ["ARF", "LinUCB", "Conformal", "Stacking", "GAOptimizer"]:
        assert component in meta["adaptive_components"]
    assert "circuit" not in params
    assert "alphaFramework" not in params


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
