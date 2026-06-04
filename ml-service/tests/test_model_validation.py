from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.model_validation import (  # noqa: E402
    build_model_cpcv_adapter_missing_evidence,
    build_model_cpcv_adapter_error_evidence,
    build_model_cpcv_evidence,
    evaluate_model_cpcv_rank_ic,
    fit_predict_ft_transformer_cpcv,
)


def test_build_model_cpcv_evidence_passes_stable_folds():
    folds = [
        {"fold_id": i, "oos_ic": 0.03, "test_rows": 120, "coverage": 0.9}
        for i in range(6)
    ]

    evidence = build_model_cpcv_evidence(model="XGBoost", fold_metrics=folds)

    assert evidence["decision"] == "PASS"
    assert evidence["method"] == "purged_cpcv_rank_ic"
    assert evidence["folds"] == 6


def test_build_model_cpcv_evidence_fails_low_coverage():
    evidence = build_model_cpcv_evidence(
        model="FT-Transformer",
        fold_metrics=[
            {"fold_id": 1, "oos_ic": 0.01, "test_rows": 80, "coverage": 0.3},
            {"fold_id": 2, "oos_ic": -0.01, "test_rows": 60, "coverage": 0.3},
        ],
    )

    assert evidence["decision"] == "FAIL"
    assert "cpcv_coverage" in evidence["failed_gates"]


def test_build_model_cpcv_adapter_missing_evidence_fails_visible():
    evidence = build_model_cpcv_adapter_missing_evidence(
        model="FT-Transformer",
        family="tabular_deep",
        adapter="fit_predict_ft_transformer_cpcv",
        cost_estimate={"additional_fit_count": 15},
    )

    assert evidence["decision"] == "FAIL"
    assert evidence["method"] == "family_specific_cpcv_adapter_missing"
    assert "cpcv_adapter_missing" in evidence["failed_gates"]
    assert evidence["cost_estimate"]["additional_fit_count"] == 15


def test_build_model_cpcv_adapter_error_evidence_fails_visible():
    evidence = build_model_cpcv_adapter_error_evidence(
        model="FT-Transformer",
        family="tabular_deep",
        adapter="fit_predict_ft_transformer_cpcv",
        error="torch runtime unavailable",
    )

    assert evidence["decision"] == "FAIL"
    assert evidence["method"] == "family_specific_cpcv_adapter_error"
    assert "cpcv_adapter_error" in evidence["failed_gates"]
    assert evidence["error"] == "torch runtime unavailable"


def test_evaluate_model_cpcv_rank_ic_uses_purged_combinatorial_splits():
    dates = np.array([f"D{(i // 4) + 1:03d}" for i in range(320)])
    y = np.linspace(0.0, 1.0, len(dates))
    X = y.reshape(-1, 1)
    seen: list[tuple[int, int]] = []

    def fit_predict(train_idx, test_idx):
        seen.append((len(train_idx), len(test_idx)))
        return y[test_idx]

    evidence = evaluate_model_cpcv_rank_ic(
        model="SyntheticRanker",
        X=X,
        y=y,
        dates=dates,
        fit_predict=fit_predict,
        n_groups=5,
        n_test_groups=2,
        embargo_days=1,
        min_train_groups=2,
        policy={"min_folds": 5, "min_test_rows": 40, "min_coverage": 0.8},
    )

    assert evidence["decision"] == "PASS"
    assert evidence["folds"] == 10
    assert len(seen) == 10


def test_fit_predict_ft_transformer_cpcv_is_retired_fail_closed():
    X = np.linspace(0.0, 1.0, 80, dtype=np.float32).reshape(-1, 1)
    y = X[:, 0].astype(np.float32)
    train_idx = np.arange(0, 60)
    test_idx = np.arange(60, 80)

    with pytest.raises(RuntimeError, match="retired"):
        fit_predict_ft_transformer_cpcv(X, y, train_idx, test_idx, params={})
