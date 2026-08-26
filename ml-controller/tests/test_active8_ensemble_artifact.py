from __future__ import annotations

from datetime import date, timedelta

import pytest

from services.active8_ensemble_artifact import (
    ARTIFACT_SCHEMA_VERSION,
    build_active8_ensemble_artifact,
)
from services.active8_oof_stacker import ACTIVE8_MODELS


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
    assert first["fit"]["method"] == "ridge_full_fit_after_heldout_chronological_oof_validation"
    assert len(first["fit"]["coefficients"]) == 16
    assert set(first["base_artifacts"]) == set(ACTIVE8_MODELS)
    assert first["validation"]["decision"] == "PASS"
    assert first["signal_policy"]["top_k"] is None
    assert first["signal_policy"]["buy_rule"] == "conformal_lower_bound_gt_zero"


def test_later_chronological_validation_can_reject_calibration_period_winner():
    with pytest.raises(ValueError, match="active8_ensemble_validation_failed"):
        _build(_rows(reverse_late=True))


def test_constant_scores_cannot_manufacture_rank_ic():
    with pytest.raises(ValueError, match="active8_ensemble_(probability_calibration_insufficient|validation_failed)"):
        _build(_rows(constant_scores=True))


def test_one_fold_diagnostic_cannot_create_serving_ensemble():
    with pytest.raises(ValueError, match="active8_ensemble_outer_folds_insufficient"):
        _build(_rows(one_fold=True))