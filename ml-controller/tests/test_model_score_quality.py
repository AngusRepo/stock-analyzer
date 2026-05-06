from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_score_quality import drop_degenerate_rank_scores  # noqa: E402


def test_drop_degenerate_rank_scores_removes_constant_model_only():
    rows = {
        f"S{i}": {
            "rank_scores": {
                "FT-Transformer": 0.0,
                "XGBoost": i / 20,
            }
        }
        for i in range(12)
    }

    dropped = drop_degenerate_rank_scores(rows, min_samples=10)

    assert dropped == {
        "FT-Transformer": {
            "n_samples": 12,
            "constant_value": 0.0,
            "score_field": "rank_scores",
        }
    }
    assert all("FT-Transformer" not in row["rank_scores"] for row in rows.values())
    assert all("XGBoost" in row["rank_scores"] for row in rows.values())
    assert all(
        "FT-Transformer: dropped degenerate constant rank_scores" in row["model_errors"]
        for row in rows.values()
    )


def test_drop_degenerate_rank_scores_keeps_small_slates():
    rows = {
        f"S{i}": {"rank_scores": {"FT-Transformer": 0.0}}
        for i in range(3)
    }

    dropped = drop_degenerate_rank_scores(rows, min_samples=10)

    assert dropped == {}
    assert all("FT-Transformer" in row["rank_scores"] for row in rows.values())
