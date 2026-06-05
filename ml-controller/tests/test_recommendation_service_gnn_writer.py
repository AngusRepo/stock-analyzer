from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.recommendation_service import _extract_per_model_scores_for_d1  # noqa: E402


def test_extract_per_model_scores_tracks_gnn_payload_when_rank_scores_dropped():
    out = _extract_per_model_scores_for_d1(
        {
            "rank_scores": {"XGBoost": 0.6},
            "gnn": {"rank_score": 0.74, "runtime": "graphsage_full_universe"},
        }
    )

    assert out["XGBoost"] == 0.6
    assert out["GNN"] == 0.74
