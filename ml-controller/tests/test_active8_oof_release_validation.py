from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active8_oof_release_validation import build_active8_oof_release_validation


def test_release_validation_is_candidate_scoped_and_never_fakes_capital_path():
    rows = []
    models = ["LightGBM", "XGBoost", "ExtraTrees", "DLinear"]
    for date_index in range(40):
        date = f"2026-06-{date_index + 1:02d}"
        for model_index, model_name in enumerate(models):
            for symbol_index in range(10):
                rows.append({
                    "model_name": model_name,
                    "prediction_date": date,
                    "market_segment": "LISTED",
                    "rank_score": symbol_index / 10,
                    "target_return": (
                        0.02 + model_index * 0.001
                        if symbol_index >= 8
                        else -0.005
                    ),
                })

    result = build_active8_oof_release_validation(
        rows,
        eligible_models=models[:3],
        cohort_id="cohort-v3",
        source_manifest_checksum="a" * 64,
    )

    assert result["common_dates"] == 40
    assert result["partition_count"] == 10
    for model_name in models[:3]:
        evidence = result["by_model"][model_name]
        assert evidence["validation_role"] == "base_ranker"
        assert evidence["pbo"]["scope"] == "candidate_oof_cohort"
        assert evidence["pbo"]["method"] == "cscv_rank_logit"
        assert evidence["overlapping_label_policy"]["monte_carlo_mdd"].startswith(
            "owned_by_final"
        )
        assert "monte_carlo" not in evidence
        assert "deflated_sharpe" not in evidence
