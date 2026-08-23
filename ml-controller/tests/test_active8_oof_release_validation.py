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
    assert result["schema_version"].endswith("-v3")
    assert result["search_models"] == sorted(models[:3])
    cohort_pbo = result["cohort_selection_validation"]
    assert cohort_pbo["scope"] == "cohort_model_selection_process"
    assert cohort_pbo["policy_owner"] == "active8_oof_cohort_selection"
    assert cohort_pbo["method"] == "label_interval_purged_cscv_rank_logit"
    assert cohort_pbo["target_portfolio"].startswith("same-market-top-minus-bottom")
    assert cohort_pbo["effect"] == (
        "automatic_champion_selection_and_ensemble_weighting_only"
    )
    assert cohort_pbo["purged_train_observations"] > 0
    assert cohort_pbo["embargoed_train_observations"] > 0
    assert cohort_pbo["embargo_horizon_sessions"] == 5
    assert cohort_pbo["selection_identifiability_ratio"] == 1.0
    for model_name in models[:3]:
        evidence = result["by_model"][model_name]
        assert evidence["validation_role"] == "base_ranker"
        assert evidence["schema_version"].endswith("-v3")
        assert evidence["decision"] == "PASS"
        assert evidence["failed_gates"] == []
        assert evidence["base_artifact_authority"] == {
            "decision": "PASS",
            "owner": "individual_outer_purged_oof",
            "effect": "base_artifact_release_only",
        }
        assert evidence["selection_authority"] == cohort_pbo
        assert evidence["pbo"] == cohort_pbo
        assert evidence["target_portfolio"].startswith("same-market-top-minus-bottom")
        assert "mean_top_minus_bottom_oof_spread" in evidence["diagnostics"]
        assert evidence["overlapping_label_policy"]["monte_carlo_mdd"].startswith(
            "owned_by_final"
        )
        assert "monte_carlo" not in evidence
        assert "deflated_sharpe" not in evidence


def test_release_validation_blocks_automatic_selection_when_candidates_are_identical():
    models = ["LightGBM", "XGBoost", "ExtraTrees"]
    rows = []
    for date_index in range(40):
        date = f"2026-07-{date_index + 1:02d}"
        for model_name in models:
            for symbol_index in range(10):
                rows.append({
                    "model_name": model_name,
                    "prediction_date": date,
                    "market_segment": "LISTED",
                    "rank_score": symbol_index / 10,
                    "target_return": 0.02 if symbol_index >= 8 else -0.005,
                })

    result = build_active8_oof_release_validation(
        rows,
        eligible_models=models,
        cohort_id="cohort-identical",
        source_manifest_checksum="b" * 64,
    )

    selection = result["cohort_selection_validation"]
    assert selection["pbo"] == 0.0
    assert selection["oos_mean_spread"] > 0
    assert selection["selection_identifiability_ratio"] == 0.0
    assert selection["decision"] == "FAIL"
    assert selection["failed_gates"] == ["cohort_model_selection_pbo"]
    for evidence in result["by_model"].values():
        assert evidence["decision"] == "PASS"
        assert evidence["base_artifact_authority"]["decision"] == "PASS"
        assert evidence["selection_authority"]["decision"] == "FAIL"
