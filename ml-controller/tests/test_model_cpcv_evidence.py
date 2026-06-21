from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_cpcv_evidence import (  # noqa: E402
    build_foundation_forecast_validation_evidence,
    build_model_cpcv_evidence,
)


def test_model_cpcv_evidence_passes_stable_positive_rank_ic():
    folds = [
        {"fold_id": i, "oos_ic": 0.02 + i * 0.001, "test_rows": 180, "coverage": 0.90}
        for i in range(6)
    ]

    evidence = build_model_cpcv_evidence(model="LightGBM", fold_metrics=folds)

    assert evidence["decision"] == "PASS"
    assert evidence["method"] == "purged_cpcv_rank_ic"
    assert evidence["folds"] == 6
    assert evidence["failed_gates"] == []


def test_model_cpcv_evidence_fails_low_fold_count_and_coverage():
    folds = [
        {"fold_id": "A", "rank_ic": 0.04, "test_rows": 12, "coverage": 0.30},
        {"fold_id": "B", "rank_ic": -0.01, "test_rows": 15, "coverage": 0.20},
    ]

    evidence = build_model_cpcv_evidence(model="TabM", fold_metrics=folds)

    assert evidence["decision"] == "FAIL"
    assert "cpcv_fold_count" in evidence["failed_gates"]
    assert "cpcv_test_rows" in evidence["failed_gates"]
    assert "cpcv_coverage" in evidence["failed_gates"]


def test_learned_sequence_coverage_uses_oos_union_not_fold_share_mean():
    folds = [
        {"fold_id": i, "oos_ic": 0.31 + i * 0.001, "test_rows": 204, "coverage": 0.20}
        for i in range(5)
    ]

    evidence = build_model_cpcv_evidence(model="PatchTST", fold_metrics=folds)

    assert evidence["decision"] == "PASS"
    assert evidence["coverage_mean"] == 0.2
    assert evidence["coverage_gate_value"] == 1.0
    assert evidence["coverage_gate_semantics"] == "legacy_coverage_fold_share_sum_capped"
    assert "cpcv_coverage" not in evidence["failed_gates"]


def test_learned_sequence_coverage_fix_does_not_hide_itransformer_signal_failures():
    folds = [
        {"fold_id": 1, "oos_ic": -0.08, "test_rows": 204, "coverage": 0.20},
        {"fold_id": 2, "oos_ic": -0.05, "test_rows": 204, "coverage": 0.20},
        {"fold_id": 3, "oos_ic": 0.01, "test_rows": 204, "coverage": 0.20},
        {"fold_id": 4, "oos_ic": -0.04, "test_rows": 204, "coverage": 0.20},
        {"fold_id": 5, "oos_ic": 0.02, "test_rows": 204, "coverage": 0.20},
    ]

    evidence = build_model_cpcv_evidence(model="iTransformer", fold_metrics=folds)

    assert evidence["decision"] == "FAIL"
    assert evidence["coverage_gate_value"] == 1.0
    assert "cpcv_coverage" not in evidence["failed_gates"]
    assert "cpcv_oos_ic" in evidence["failed_gates"]
    assert "cpcv_positive_fold_ratio" in evidence["failed_gates"]


def test_model_cpcv_evidence_fails_unstable_or_negative_signal():
    folds = [
        {"fold_id": 1, "oos_ic": 0.70, "test_rows": 200, "coverage": 0.95},
        {"fold_id": 2, "oos_ic": -0.55, "test_rows": 210, "coverage": 0.95},
        {"fold_id": 3, "oos_ic": -0.40, "test_rows": 205, "coverage": 0.95},
        {"fold_id": 4, "oos_ic": 0.01, "test_rows": 220, "coverage": 0.95},
        {"fold_id": 5, "oos_ic": -0.02, "test_rows": 190, "coverage": 0.95},
    ]

    evidence = build_model_cpcv_evidence(model="PatchTST", fold_metrics=folds)

    assert evidence["decision"] == "FAIL"
    assert "cpcv_positive_fold_ratio" in evidence["failed_gates"]
    assert "cpcv_ic_instability" in evidence["failed_gates"]


def test_timesfm_sample_complete_cpcv_keeps_dataset_coverage_informational():
    folds = [
        {
            "fold_id": f"timesfm_{i}",
            "oos_ic": 0.04 + i * 0.001,
            "test_rows": 64,
            "coverage": 1.0,
            "sampled_coverage": 1.0,
            "dataset_coverage": 0.125,
            "fold_share": 0.2,
        }
        for i in range(5)
    ]

    evidence = build_model_cpcv_evidence(
        model="TimesFM",
        family="foundation_time_series_timesfm25",
        fold_metrics=folds,
        stage="research_benchmark",
        search_trials=1,
        coverage_mode="sample_complete",
    )

    assert evidence["decision"] == "PASS"
    assert evidence["family"] == "foundation_sequence"
    assert evidence["policy"]["coverage_mode"] == "sample_complete"
    assert "cpcv_coverage" not in evidence["failed_gates"]
    assert evidence["fold_metrics"][0]["dataset_coverage"] == 0.125


def test_foundation_forecast_validation_is_lifecycle_compatible_without_retrain():
    evidence = build_foundation_forecast_validation_evidence(
        model="TimesFM",
        predictions=[
            {"symbol": "2330", "forecast_pct": 0.05, "up_prob": 0.7, "confidence": 0.7},
            {"symbol": "2317", "forecast_pct": 0.03, "up_prob": 0.6, "confidence": 0.6},
            {"symbol": "1301", "forecast_pct": -0.04, "up_prob": 0.3, "confidence": 0.7},
            {"symbol": "2882", "forecast_pct": -0.02, "up_prob": 0.4, "confidence": 0.6},
        ],
        realized_returns={
            "2330": 0.06,
            "2317": 0.02,
            "1301": -0.05,
            "2882": -0.01,
        },
        policy={"min_samples": 4, "min_rank_ic": 0.5, "min_direction_accuracy": 0.7},
    )

    assert evidence["model"] == "TimesFM"
    assert evidence["method"] == "foundation_forecast_rank_ic"
    assert evidence["decision"] == "PASS"
    assert evidence["retrain_required"] is False
    assert evidence["folds"] == 1
    assert evidence["direction_accuracy"] == 1.0


def test_foundation_forecast_validation_sample_rows_use_null_for_missing_probabilities():
    evidence = build_foundation_forecast_validation_evidence(
        model="TimesFM",
        predictions=[{"symbol": "2330", "forecast_pct": 0.05}],
        realized_returns={"2330": 0.06},
        policy={"min_samples": 1},
    )

    assert evidence["sample_rows"][0]["up_prob"] is None
    assert evidence["sample_rows"][0]["confidence"] is None


def test_foundation_forecast_validation_fails_closed_without_verified_outcomes():
    evidence = build_foundation_forecast_validation_evidence(
        model="TimesFM",
        predictions=[{"symbol": "2330", "forecast_pct": 0.05}],
        realized_returns={},
        policy={"min_samples": 1},
    )

    assert evidence["decision"] == "FAIL"
    assert "foundation_outcome_missing" in evidence["failed_gates"]
    assert "foundation_min_samples" in evidence["failed_gates"]
