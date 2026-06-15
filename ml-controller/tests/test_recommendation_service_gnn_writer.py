from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.recommendation_service import (  # noqa: E402
    _extract_per_model_scores_for_d1,
    _per_model_signal_payload,
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
