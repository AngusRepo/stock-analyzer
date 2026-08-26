from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

from services.active8_ensemble_artifact import build_active8_ensemble_artifact
from services.active8_oof_stacker import ACTIVE8_MODELS
from services.active8_score_semantics import (
    MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
    MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION,
)
from services.ensemble_v2 import attach_ensemble_v2


ROOT = Path(__file__).resolve().parents[2]


def _base_artifacts() -> dict:
    return {
        name: {
            "artifact_id": f"{name}:v-new:oof_full_fit_release",
            "version": "v-new",
            "checksum": "sha256:" + format(index + 1, "064x"),
            "candidate_type": "oof_full_fit_release",
        }
        for index, name in enumerate(ACTIVE8_MODELS)
    }


def _artifact() -> dict:
    rows = []
    start = date(2026, 1, 2)
    for day_index in range(45):
        prediction_date = start + timedelta(days=day_index)
        for symbol_index in range(40):
            target = (symbol_index - 19.5) / 1000.0
            for model_index, model_name in enumerate(ACTIVE8_MODELS):
                rows.append({
                    "fold_id": f"w{day_index // 9}",
                    "prediction_date": prediction_date.isoformat(),
                    "symbol": f"S{symbol_index:03d}",
                    "market_segment": "LISTED",
                    "target_return": target,
                    "label_known_date": (prediction_date + timedelta(days=6)).isoformat(),
                    "artifact_version": f"{model_name}-fold-w{day_index // 9}",
                    "raw_score": target + model_index * 1e-5,
                    "rank_score": target + model_index * 1e-5,
                    "test_start": prediction_date.isoformat(),
                    "test_end": prediction_date.isoformat(),
                    "model_name": model_name,
                })
    return build_active8_ensemble_artifact(
        rows,
        base_artifacts=_base_artifacts(),
        cohort_id="cohort-v1",
        source_manifest_checksum="a" * 64,
        knowledge_cutoff_date="2026-03-31",
    )


def _pool() -> dict[str, dict]:
    return {
        name: {
            "serving_artifact_id": identity["artifact_id"],
            "version": identity["version"],
            "checksum": identity["checksum"],
            "serving_eligible": True,
        }
        for name, identity in _base_artifacts().items()
    }


def test_controller_and_modal_share_exact_learned_artifact_semantics() -> None:
    artifact = _artifact()
    scores = {name: 0.62 + index * 0.01 for index, name in enumerate(ACTIVE8_MODELS)}
    prediction = {
        "rank_scores": scores,
        "model_score_lineage": {
            "schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
            "semantic_version": MODEL_SCORE_SEMANTIC_VERSION,
            "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
            "complete": True,
            "blockers": [],
        },
    }
    attach_ensemble_v2(prediction, artifact, _pool())

    sys.path.insert(0, str(ROOT / "ml-service"))
    try:
        from app.active8_ensemble_runtime import score_active8_ensemble

        modal = score_active8_ensemble(
            rank_scores=scores,
            artifact=artifact,
            pool_models=_pool(),
            current_price=100.0,
        )
    finally:
        sys.path.pop(0)

    controller = prediction["ensemble_v2"]
    assert controller["signal"] == modal.signal
    assert controller["forecast_pct"] == modal.forecast_pct
    assert controller["probability_positive_net_return"] == modal.evidence["probability_positive_net_return"]
    assert controller["artifact_checksum"] == artifact["payload_checksum"]
    assert controller["top_k"] is None


def test_formal_l3_call_path_contains_no_legacy_formula_owner() -> None:
    paths = [
        ROOT / "ml-controller" / "graphs" / "daily_pipeline_v2.py",
        ROOT / "ml-controller" / "services" / "ensemble_v2.py",
        ROOT / "ml-service" / "app" / "batch_prediction.py",
        ROOT / "ml-service" / "app" / "prediction_runtime.py",
        ROOT / "ml-service" / "app" / "serving_resolver.py",
    ]
    joined = "\n".join(path.read_text(encoding="utf-8") for path in paths)
    for forbidden in (
        "_build_serving_ic_bundle",
        "load_ic_weights",
        "merge_with_time_series",
        "score_to_signal(",
        "apply_rank_stacker",
        "topKOverrideEnabled",
        "allowLegacyTopKOverride",
    ):
        assert forbidden not in joined
    assert "active8_ensemble_pointer_v1" in joined
    assert 'OOF_PROMOTION_MIN_FOLDS = 5' in (
        ROOT / "ml-controller" / "routers" / "walk_forward.py"
    ).read_text(encoding="utf-8")


def test_retired_toggle_and_single_model_release_owners_are_absent() -> None:
    controller_paths = [
        ROOT / "ml-controller" / "services" / "recommendation_service.py",
        ROOT / "ml-controller" / "graphs" / "daily_pipeline_v2.py",
        ROOT / "ml-controller" / "routers" / "retrain_followup.py",
    ]
    joined = "\n".join(path.read_text(encoding="utf-8") for path in controller_paths)
    for retired in (
        "_is_use_ensemble_v2",
        "_load_pool_and_ic",
        "_run_monthly_oof_lifecycle",
    ):
        assert retired not in joined
    for retired_file in (
        ROOT / "ml-service" / "app" / "ensemble.py",
        ROOT / "ml-service" / "app" / "stacking.py",
        ROOT / "ml-controller" / "routers" / "lifecycle.py",
        ROOT / "ml-controller" / "routers" / "retrain.py",
    ):
        assert not retired_file.exists()
