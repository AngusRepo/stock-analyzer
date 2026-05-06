from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_cpcv_evidence import (  # noqa: E402
    build_chronos_forecast_validation_evidence,
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
        {"fold_id": "A", "rank_ic": 0.04, "test_rows": 40, "coverage": 0.30},
        {"fold_id": "B", "rank_ic": -0.01, "test_rows": 30, "coverage": 0.20},
    ]

    evidence = build_model_cpcv_evidence(model="FT-Transformer", fold_metrics=folds)

    assert evidence["decision"] == "FAIL"
    assert "cpcv_fold_count" in evidence["failed_gates"]
    assert "cpcv_test_rows" in evidence["failed_gates"]
    assert "cpcv_coverage" in evidence["failed_gates"]


def test_model_cpcv_evidence_fails_unstable_or_negative_signal():
    folds = [
        {"fold_id": 1, "oos_ic": 0.35, "test_rows": 200, "coverage": 0.95},
        {"fold_id": 2, "oos_ic": -0.30, "test_rows": 210, "coverage": 0.95},
        {"fold_id": 3, "oos_ic": -0.10, "test_rows": 205, "coverage": 0.95},
        {"fold_id": 4, "oos_ic": 0.01, "test_rows": 220, "coverage": 0.95},
        {"fold_id": 5, "oos_ic": -0.02, "test_rows": 190, "coverage": 0.95},
    ]

    evidence = build_model_cpcv_evidence(model="PatchTST", fold_metrics=folds)

    assert evidence["decision"] == "FAIL"
    assert "cpcv_positive_fold_ratio" in evidence["failed_gates"]
    assert "cpcv_ic_instability" in evidence["failed_gates"]


def test_chronos_forecast_validation_is_lifecycle_compatible_without_retrain():
    evidence = build_chronos_forecast_validation_evidence(
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

    assert evidence["model"] == "Chronos"
    assert evidence["method"] == "chronos_forecast_rank_ic"
    assert evidence["decision"] == "PASS"
    assert evidence["retrain_required"] is False
    assert evidence["folds"] == 1
    assert evidence["direction_accuracy"] == 1.0


def test_chronos_forecast_validation_fails_closed_without_verified_outcomes():
    evidence = build_chronos_forecast_validation_evidence(
        predictions=[{"symbol": "2330", "forecast_pct": 0.05}],
        realized_returns={},
        policy={"min_samples": 1},
    )

    assert evidence["decision"] == "FAIL"
    assert "chronos_outcome_missing" in evidence["failed_gates"]
    assert "chronos_min_samples" in evidence["failed_gates"]
