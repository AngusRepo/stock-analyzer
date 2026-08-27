import pytest

from app.active8_ensemble_runtime import (
    Active8EnsembleContractError,
    _payload_checksum,
    score_active8_ensemble,
    validate_active8_ensemble_artifact,
)
from app.model_serving_contract import ALPHA_PREDICTION_MODELS


def _pool_models():
    return {
        name: {
            "serving_artifact_id": f"{name}:v-new:oof_full_fit_release",
            "version": "v-new",
            "checksum": "sha256:" + format(index + 1, "064x"),
            "serving_eligible": True,
        }
        for index, name in enumerate(ALPHA_PREDICTION_MODELS)
    }


def _artifact():
    coefficients = [0.0] * 16
    coefficients[0] = 0.10
    payload = {
        "schema_version": "active8-oof-ensemble-serving-artifact-v1",
        "ensemble_semantic_version": "active8-purged-oof-chronological-nonnegative-ridge-v5",
        "calibration_schema_version": "active8-chronological-conformal-isotonic-v1",
        "signal_policy": {
            "schema_version": "active8-net-return-conformal-signal-policy-v1",
            "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
            "net_return_zero_boundary": 0.0,
            "buy_coverage": 0.9,
            "strong_coverage": 0.95,
            "buy_rule": "conformal_lower_bound_gt_zero",
            "sell_rule": "conformal_upper_bound_lt_zero",
            "top_k": None,
        },
        "cohort_id": "cohort-v1",
        "source_manifest_checksum": "a" * 64,
        "knowledge_cutoff_date": "2026-08-25",
        "observation_artifacts": {
            name: {
                "artifact_id": f"{name}:v-new:oof_full_fit_release",
                "version": "v-new",
                "checksum": "sha256:" + format(index + 1, "064x"),
                "candidate_type": "oof_full_fit_release",
            }
            for index, name in enumerate(ALPHA_PREDICTION_MODELS)
        },
        "observation_artifact_set_checksum": "a" * 64,
        "base_artifacts": {
            "LightGBM": {
                "artifact_id": "LightGBM:v-new:oof_full_fit_release",
                "version": "v-new",
                "checksum": "sha256:" + format(1, "064x"),
                "candidate_type": "oof_full_fit_release",
            }
        },
        "base_artifact_set_checksum": "b" * 64,
        "selected_models": ["LightGBM"],
        "excluded_models": [
            name for name in ALPHA_PREDICTION_MODELS if name != "LightGBM"
        ],
        "feature_names": [
            *[f"{name}.rank" for name in ALPHA_PREDICTION_MODELS],
            *[f"{name}.available" for name in ALPHA_PREDICTION_MODELS],
        ],
        "model_order": list(ALPHA_PREDICTION_MODELS),
        "fit": {
            "method": "nonnegative_rank_ridge_full_fit_after_heldout_chronological_oof_validation",
            "rank_coefficient_constraint": "nonnegative",
            "regularization": 1.0,
            "intercept": -0.05,
            "coefficients": coefficients,
            "train_rows": 2000,
            "train_dates": 30,
            "outer_folds": 5,
        },
        "calibration": {
            "absolute_residual_quantiles": {"0.9": 0.01, "0.95": 0.02},
            "probability_x_thresholds": [-0.1, 0.1],
            "probability_y_thresholds": [0.0, 1.0],
            "oof_rows": 1000,
            "oof_dates": 20,
        },
        "validation": {
            "decision": "PASS",
            "method": "chronological_oof_calibration_then_later_validation",
            "failed_gates": [],
            "validation_dates": 8,
            "validation_rows": 320,
            "rank_ic": 0.1,
            "rank_ic_equal_date_market_lcb90": 0.02,
            "top_bottom_net_return_spread": 0.01,
            "top_bottom_net_return_spread_lcb90": 0.001,
        },
    }
    payload["payload_checksum"] = _payload_checksum(payload)
    return payload


def test_runtime_uses_learned_return_and_conformal_bounds_without_top_k():
    scores = {name: 0.6 for name in ALPHA_PREDICTION_MODELS}
    scores["LightGBM"] = 0.9
    result = score_active8_ensemble(
        rank_scores=scores,
        artifact=_artifact(),
        pool_models=_pool_models(),
        current_price=100.0,
    )
    assert result.signal == "STRONG_BUY"
    assert result.forecast_pct == pytest.approx(0.04)
    assert result.stop_loss is None and result.target1 is None and result.target2 is None
    assert result.evidence["signal_policy"]["top_k"] is None


def test_runtime_binds_selected_identity_but_ignores_unselected_pointer_drift():
    pool = _pool_models()
    pool["PatchTST"]["version"] = "stale"
    validate_active8_ensemble_artifact(_artifact(), pool_models=pool)

    pool["LightGBM"]["version"] = "stale"
    with pytest.raises(Active8EnsembleContractError, match="base_artifact_mismatch:LightGBM"):
        validate_active8_ensemble_artifact(_artifact(), pool_models=pool)


def test_excluded_model_cannot_retain_hidden_weight():
    artifact = _artifact()
    artifact["fit"]["coefficients"][6] = 0.01
    artifact["payload_checksum"] = _payload_checksum(artifact)
    with pytest.raises(Active8EnsembleContractError, match="excluded_model_has_weight:PatchTST"):
        validate_active8_ensemble_artifact(artifact, pool_models=_pool_models())


def test_negative_rank_coefficient_is_rejected():
    artifact = _artifact()
    artifact["fit"]["coefficients"][0] = -0.01
    artifact["payload_checksum"] = _payload_checksum(artifact)
    with pytest.raises(Active8EnsembleContractError, match="fit_contract_invalid"):
        validate_active8_ensemble_artifact(artifact, pool_models=_pool_models())


def test_one_fold_artifact_is_not_serving_grade():
    artifact = _artifact()
    artifact["fit"]["outer_folds"] = 1
    artifact["payload_checksum"] = _payload_checksum(artifact)
    with pytest.raises(Active8EnsembleContractError, match="fit_contract_invalid"):
        validate_active8_ensemble_artifact(artifact, pool_models=_pool_models())


def test_core_model_missing_fails_but_trained_sequence_missingness_is_explicit():
    artifact = _artifact()
    scores = {name: 0.6 for name in ALPHA_PREDICTION_MODELS if name != "DLinear"}
    result = score_active8_ensemble(
        rank_scores=scores,
        artifact=artifact,
        pool_models=_pool_models(),
        current_price=100.0,
    )
    assert result.evidence["availability"]["DLinear"] is False

    del scores["LightGBM"]
    with pytest.raises(Active8EnsembleContractError, match="core_score_missing:LightGBM"):
        score_active8_ensemble(
            rank_scores=scores,
            artifact=artifact,
            pool_models=_pool_models(),
            current_price=100.0,
        )