from __future__ import annotations

from datetime import date, timedelta

import pytest

from services.active8_ensemble_artifact import (
    Active8EnsembleValidationError,
    ARTIFACT_SCHEMA_VERSION,
    build_active8_ensemble_artifact,
)
from services.active8_oof_stacker import ACTIVE8_MODELS, _fit_ridge


def _base_artifacts():
    return {
        name: {
            "artifact_id": f"{name}:v-new:oof_full_fit_release",
            "version": "v-new",
            "checksum": "sha256:" + (format(index + 1, "064x")),
            "candidate_type": "oof_full_fit_release",
        }
        for index, name in enumerate(ACTIVE8_MODELS)
    }


def _rows(*, reverse_late: bool = False, constant_scores: bool = False, one_fold: bool = False):
    rows = []
    start = date(2026, 1, 2)
    for day_index in range(45):
        prediction_date = start + timedelta(days=day_index)
        label_known_date = prediction_date + timedelta(days=6)
        fold_id = "w0" if one_fold else f"w{day_index // 9}"
        for symbol_index in range(40):
            latent = (symbol_index - 19.5) / 1000.0
            target = -latent if reverse_late and day_index >= 27 else latent
            for model_index, model_name in enumerate(ACTIVE8_MODELS):
                raw_score = 0.5 if constant_scores else latent + model_index * 1e-5
                rows.append({
                    "fold_id": fold_id,
                    "prediction_date": prediction_date.isoformat(),
                    "symbol": f"S{symbol_index:03d}",
                    "market_segment": "LISTED",
                    "target_return": target,
                    "label_known_date": label_known_date.isoformat(),
                    "artifact_version": f"{model_name}-fold-{fold_id}",
                    "raw_score": raw_score,
                    "rank_score": raw_score,
                    "test_start": prediction_date.isoformat(),
                    "test_end": prediction_date.isoformat(),
                    "model_name": model_name,
                })
    return rows


def _build(rows):
    return build_active8_ensemble_artifact(
        rows,
        base_artifacts=_base_artifacts(),
        cohort_id="cohort-v1",
        source_manifest_checksum="a" * 64,
        knowledge_cutoff_date="2026-03-31",
    )


def test_artifact_is_deterministic_learned_and_binds_all_eight_models():
    first = _build(_rows())
    second = _build(_rows())

    assert first == second
    assert first["schema_version"] == ARTIFACT_SCHEMA_VERSION
    assert first["payload_checksum"] == second["payload_checksum"]
    assert first["fit"]["outer_folds"] == 5
    assert first["fit"]["method"] == "nonnegative_rank_ridge_full_fit_after_heldout_chronological_oof_validation"
    assert first["fit"]["rank_coefficient_constraint"] == "nonnegative"
    assert len(first["fit"]["coefficients"]) == 16
    assert all(value >= -1e-12 for value in first["fit"]["coefficients"][:8])
    assert set(first["observation_artifacts"]) == set(ACTIVE8_MODELS)
    assert set(first["base_artifacts"]) == set(first["selected_models"])
    assert set(first["excluded_models"]) == set(ACTIVE8_MODELS) - set(first["selected_models"])
    assert first["validation"]["decision"] == "PASS"
    assert first["validation"]["rank_ic_equal_date_market_lcb90"] > 0.0
    assert first["validation"]["top_bottom_net_return_spread_lcb90"] > 0.0
    assert set(first["validation"]["same_window_comparison"]["models"]) == set(ACTIVE8_MODELS)
    assert first["signal_policy"]["top_k"] is None
    assert first["signal_policy"]["buy_rule"] == "conformal_lower_bound_gt_zero"


def test_later_chronological_validation_can_reject_calibration_period_winner():
    with pytest.raises(Active8EnsembleValidationError, match="active8_ensemble_validation_failed") as exc_info:
        _build(_rows(reverse_late=True))
    validation = exc_info.value.validation
    assert validation["decision"] == "FAIL"
    assert (
        "chronological_validation_equal_date_market_rank_ic_lcb90_non_positive"
        in validation["failed_gates"]
    )
    assert validation["validation_start_date"] < validation["validation_end_date"]
    comparison = validation["same_window_comparison"]
    assert comparison["window_start"] == validation["validation_start_date"]
    assert comparison["window_end"] == validation["validation_end_date"]


def test_constant_scores_cannot_manufacture_rank_ic():
    with pytest.raises(ValueError, match="active8_ensemble_(probability_calibration_insufficient|validation_failed)"):
        _build(_rows(constant_scores=True))


def test_one_fold_diagnostic_cannot_create_serving_ensemble():
    with pytest.raises(ValueError, match="active8_ensemble_outer_folds_insufficient"):
        _build(_rows(one_fold=True))


def test_nonnegative_rank_ridge_cannot_invert_an_anti_predictive_model():
    import numpy as np

    feature = np.linspace(0.0, 1.0, 100)
    x = np.zeros((100, 16), dtype=float)
    x[:, 0] = feature
    x[:, 8] = 1.0
    weights, _ = _fit_ridge(x, -feature, 0.1)
    assert weights[0] >= -1e-12
    assert weights[0] == pytest.approx(0.0, abs=1e-8)