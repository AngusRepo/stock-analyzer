from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_validation_policy import resolve_model_validation_policy  # noqa: E402


def test_timesfm_single_official_config_uses_forecast_validation_without_pbo():
    policy = resolve_model_validation_policy(
        model_name="TimesFM",
        family="foundation_time_series_timesfm25",
        stage="promotion",
        search_trials=1,
        sample_count=512,
    )

    assert policy["family"] == "foundation_sequence"
    assert policy["cpcv"]["owner"] == "foundation_forecast_validation"
    assert policy["pbo"]["required"] is False
    assert policy["pbo"]["method"] == "not_required_for_single_official_config"


def test_pbo_policy_tightens_for_search_trials_and_volatile_regime():
    baseline = resolve_model_validation_policy(
        model_name="LightGBM",
        stage="promotion",
        regime="bull",
        search_trials=2,
    )
    searched_volatile = resolve_model_validation_policy(
        model_name="LightGBM",
        stage="promotion",
        regime="volatile",
        search_trials=64,
    )

    assert baseline["pbo"]["required"] is True
    assert searched_volatile["pbo"]["required"] is True
    assert searched_volatile["pbo"]["max_pbo"] < baseline["pbo"]["max_pbo"]


def test_live_ic_min_rows_are_regime_adaptive():
    bull = resolve_model_validation_policy(
        model_name="XGBoost",
        stage="promotion",
        regime="bull",
    )
    volatile = resolve_model_validation_policy(
        model_name="XGBoost",
        stage="promotion",
        regime="volatile",
    )

    assert volatile["live_ic"]["min_verified_rows"] > bull["live_ic"]["min_verified_rows"]


def test_external_override_can_adjust_policy_without_callsite_thresholds(monkeypatch):
    monkeypatch.setenv(
        "MODEL_VALIDATION_POLICY_OVERRIDES_JSON",
        json.dumps(
            {
                "models": {
                    "TimesFM": {
                        "cpcv": {"min_coverage": 0.95},
                        "pbo": {
                            "required": True,
                            "method": "timesfm_context_sweep_cscv",
                            "max_pbo": 0.12,
                        },
                    }
                }
            }
        ),
    )

    policy = resolve_model_validation_policy(
        model_name="TimesFM",
        family="foundation_time_series_timesfm25",
        stage="promotion",
        search_trials=1,
    )

    assert policy["source"] == "adaptive_formula+external_override"
    assert policy["cpcv"]["min_coverage"] == 0.95
    assert policy["pbo"]["required"] is True
    assert policy["pbo"]["max_pbo"] == 0.12
