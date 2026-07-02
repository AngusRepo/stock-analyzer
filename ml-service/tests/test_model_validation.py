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


def test_learned_sequence_coverage_uses_oos_union_not_fold_share_mean():
    evidence = build_model_cpcv_evidence(
        model="PatchTST",
        fold_metrics=[
            {"fold_id": i, "oos_ic": 0.31 + i * 0.001, "test_rows": 204, "coverage": 0.20}
            for i in range(5)
        ],
    )

    assert evidence["decision"] == "PASS"
    assert evidence["coverage_mean"] == 0.2
    assert evidence["coverage_gate_value"] == 1.0
    assert evidence["coverage_gate_semantics"] == "legacy_coverage_fold_share_sum_capped"
    assert "cpcv_coverage" not in evidence["failed_gates"]


def test_learned_sequence_coverage_fix_keeps_itransformer_performance_fail_closed():
    evidence = build_model_cpcv_evidence(
        model="iTransformer",
        fold_metrics=[
            {"fold_id": 1, "oos_ic": -0.08, "test_rows": 204, "coverage": 0.20},
            {"fold_id": 2, "oos_ic": -0.05, "test_rows": 204, "coverage": 0.20},
            {"fold_id": 3, "oos_ic": 0.01, "test_rows": 204, "coverage": 0.20},
            {"fold_id": 4, "oos_ic": -0.04, "test_rows": 204, "coverage": 0.20},
            {"fold_id": 5, "oos_ic": 0.02, "test_rows": 204, "coverage": 0.20},
        ],
    )

    assert evidence["decision"] == "FAIL"
    assert evidence["coverage_gate_value"] == 1.0
    assert "cpcv_coverage" not in evidence["failed_gates"]
    assert "cpcv_oos_ic" in evidence["failed_gates"]
    assert "cpcv_positive_fold_ratio" in evidence["failed_gates"]


def test_tabm_tail_decay_fails_closed_even_when_aggregate_ic_is_positive():
    evidence = build_model_cpcv_evidence(
        model="TabM",
        family="tabular_neural",
        fold_metrics=[
            {"fold_id": 1, "oos_ic": 0.18, "test_rows": 120, "coverage": 1.0},
            {"fold_id": 2, "oos_ic": 0.14, "test_rows": 120, "coverage": 1.0},
            {"fold_id": 3, "oos_ic": 0.12, "test_rows": 120, "coverage": 1.0},
            {"fold_id": 4, "oos_ic": -0.02, "test_rows": 120, "coverage": 1.0},
            {"fold_id": 5, "oos_ic": -0.03, "test_rows": 120, "coverage": 1.0},
            {"fold_id": 6, "oos_ic": -0.01, "test_rows": 120, "coverage": 1.0},
        ],
        policy={"min_positive_fold_ratio": 0.45},
    )

    assert evidence["oos_ic_mean"] > 0
    assert evidence["decision"] == "FAIL"
    assert "cpcv_tail_oos_ic" in evidence["failed_gates"]
    assert evidence["tail_fold_stats"]["tail_oos_ic_mean"] < 0


def test_patchtst_segment_inverted_rank_fails_closed():
    evidence = build_model_cpcv_evidence(
        model="PatchTST",
        family="learned_sequence",
        coverage_mode="sequence_window",
        fold_metrics=[
            {
                "fold_id": i,
                "oos_ic": 0.10,
                "test_rows": 120,
                "coverage": 0.20,
                "segment_ic": {
                    "LISTED": {"ic": 0.08, "test_rows": 80},
                    "OTC": {"ic": -0.12, "test_rows": 60},
                },
            }
            for i in range(5)
        ],
        policy={"min_positive_fold_ratio": 0.45},
    )

    assert evidence["coverage_gate_value"] == 1.0
    assert evidence["decision"] == "FAIL"
    assert "cpcv_segment_ic" in evidence["failed_gates"]
    assert evidence["segment_ic_stats"]["OTC"]["oos_ic_mean"] < 0


def test_model_cpcv_rejects_all_zero_actual_return_days():
    evidence = build_model_cpcv_evidence(
        model="TabM",
        family="tabular_neural",
        fold_metrics=[
            {"fold_id": i, "oos_ic": 0.06, "test_rows": 120, "coverage": 1.0}
            for i in range(5)
        ] + [{
            "fold_id": "bad_zero_return_day",
            "oos_ic": 0.07,
            "test_rows": 120,
            "coverage": 1.0,
            "all_zero_actual_return_day": True,
        }],
        policy={"min_positive_fold_ratio": 0.45},
    )

    assert evidence["decision"] == "FAIL"
    assert "cpcv_actual_return_all_zero_day" in evidence["failed_gates"]
    assert evidence["return_quality_stats"]["all_zero_actual_return_days"] == 1


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
