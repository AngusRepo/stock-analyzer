from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.recommendation_service import (  # noqa: E402
    _extract_per_model_scores_for_d1,
    _per_model_signal_payload,
    _timesfm_sidecar_payload,
)


def test_extract_per_model_scores_tracks_gnn_payload_when_rank_scores_dropped():
    out = _extract_per_model_scores_for_d1(
        {
            "rank_scores": {"XGBoost": 0.6},
            "gnn": {"rank_score": 0.74, "runtime": "graphsage_full_universe"},
        }
    )

    assert out["XGBoost"] == 0.6
    assert out["GNN"] == 0.74


def test_extract_per_model_scores_keeps_timesfm_out_of_direct_alpha_rows():
    out = _extract_per_model_scores_for_d1(
        {
            "timesfm": {
                "forecast_pct": 0.05,
                "confidence": 0.7,
            },
            "dlinear": {"forecast_pct": 0.02},
        }
    )

    assert "DLinear" in out
    assert "TimesFM" not in out


def test_per_model_signal_payload_preserves_timesfm_forecast_context():
    payload = _per_model_signal_payload(
        {
            "timesfm": {
                "forecast_pct": -0.0123,
                "confidence": 0.61,
                "n_used": 1024,
                "model_version": "v20260612T160113_timesfm25_ctx1024",
                "model_id": "google/timesfm-2.5-200m-pytorch",
            }
        },
        "TimesFM",
    )

    assert payload["forecast_pct"] == -0.0123
    assert payload["confidence"] == 0.61
    assert payload["n_used"] == 1024
    assert payload["source_key"] == "timesfm"


def test_timesfm_sidecar_builds_l1_75_features_without_alpha_role():
    payload = _timesfm_sidecar_payload(
        {
            "entry_price": 100.0,
            "timesfm": {
                "forecast_pct": -0.012,
                "forecast_price": 98.8,
                "forecast_pct_path": [-0.002, -0.006, -0.012],
                "forecast_p10": -0.03,
                "forecast_p90": 0.01,
                "confidence": 0.61,
                "n_used": 1024,
            },
            "dlinear": {"forecast_pct": 0.014},
            "patchtst": {"forecast_pct": 0.010},
            "itransformer": {"forecast_pct": 0.008},
            "market_expected_return": 0.002,
            "sector_expected_return": -0.001,
        }
    )

    assert payload is not None
    assert payload["schema_version"] == "timesfm-l1-75-sidecar-v1"
    assert payload["layer"] == "L1.75"
    assert payload["role"] == "feature_sidecar"
    assert payload["direct_alpha_blocked"] is True
    features = payload["features"]
    assert features["forecast_return"] == -0.012
    assert features["forecast_log_return"] < 0
    assert features["forecast_slope"] < 0
    assert features["forecast_curvature"] == -0.002
    assert features["random_walk_residual"] == -0.012
    assert features["quantile_width"] == 0.04
    assert features["forecast_dispersion"] is not None
    assert features["market_excess_return"] == -0.014
    assert features["sector_excess_return"] == -0.011
    assert features["sign_flip_flag"] is True
