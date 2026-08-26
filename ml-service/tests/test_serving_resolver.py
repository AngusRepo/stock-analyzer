from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import serving_resolver as resolver  # noqa: E402


def test_d1_champion_pool_serves_only_valid_production_artifact():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "TabM",
            "champion_version": "vGood",
            "champion_artifact_id": "TabM:vGood:oof_full_fit_release",
            "promotion_evidence_json": {
                "rolling_ic": 0.08,
                "last_ic_status": "computed",
                "last_ic_root_cause": "ok",
                "last_ic_semantic_version": "daily-cross-sectional-equal-date-v2",
                "last_ic_artifact_version": "vGood",
                "last_ic_target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
            },
        }],
        artifacts=[{
            "artifact_id": "TabM:vGood:oof_full_fit_release",
            "model_name": "TabM",
            "version": "vGood",
            "candidate_type": "oof_full_fit_release",
            "state": "production",
            "artifact_path": "universal/tabm/vGood.pt",
            "metadata_path": "universal/tabm/metadata_vGood.json",
            "checksum": "sha256:" + "a" * 64,
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "metadata": {
                "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                "feature_semantic_version": resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
            },
        }],
        required_models=("TabM",),
        sidecar_models=(),
    )

    entry = pool["models"]["TabM"]
    assert entry["status"] == "active"
    assert entry["version"] == "vGood"
    assert entry["gcs_path"] == "universal/tabm/vGood.pt"
    assert entry["rolling_ic"] == 0.08


def test_d1_champion_pool_retires_failed_artifact_without_model_pool_fallback():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vBad",
            "champion_artifact_id": "PatchTST:vBad:oof_full_fit_release",
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vBad:oof_full_fit_release",
            "model_name": "PatchTST",
            "version": "vBad",
            "candidate_type": "oof_full_fit_release",
            "state": "production",
            "artifact_path": "universal/patchtst/vBad.zip",
            "offline_gate_decision": "FAIL",
            "live_gate_status": "failed",
        }],
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert entry["status"] == "degraded"
    assert entry["model_slot_status"] == "active"
    assert entry["serving_eligible"] is False
    assert entry["version"] == "vBad"
    assert entry["gcs_path"] == "universal/patchtst/vBad.zip"
    assert entry["serving_block_reason"] == "offline_gate_fail"


def test_patchtst_d1_champion_rejects_legacy_pt_artifact():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vLegacy",
            "champion_artifact_id": "PatchTST:vLegacy:weekly_drift",
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vLegacy:weekly_drift",
            "model_name": "PatchTST",
            "version": "vLegacy",
            "candidate_type": "weekly_drift",
            "state": "production",
            "artifact_path": "universal/patchtst/vLegacy.pt",
            "metadata_path": "universal/patchtst/metadata_vLegacy.json",
            "checksum": "sha256:" + "b" * 64,
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
        }],
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert entry["status"] == "degraded"
    assert entry["model_slot_status"] == "active"
    assert entry["serving_eligible"] is False
    assert entry["version"] == "vLegacy"
    assert entry["gcs_path"] == "universal/patchtst/vLegacy.pt"
    assert entry["serving_block_reason"] == "artifact_extension_pt_expected_zip"


def test_oof_champion_projects_version_bound_ic_prior_and_quarantines_stale_live_ic():
    artifact = {
        "artifact_id": "XGBoost:v2:oof_full_fit_release",
        "model_name": "XGBoost",
        "version": "v2",
        "candidate_type": "oof_full_fit_release",
        "state": "production",
        "artifact_path": "universal/xgboost/v2.joblib",
        "metadata_path": "universal/xgboost/metadata_v2.json",
        "checksum": "sha256:" + "c" * 64,
        "offline_gate_decision": "STRONG_PASS",
        "live_gate_status": "not_started",
        "metadata": {
            "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
            "feature_semantic_version": resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
            "sample_count": 1200,
            "model_cpcv": {
                "method": "outer_purged_walk_forward_rank_ic",
                "decision": "PASS",
                "passed": True,
                "oos_ic_mean": 0.062,
                "folds": 5,
                "positive_fold_ratio": 0.8,
            },
        },
    }
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "XGBoost",
            "champion_version": "v2",
            "champion_artifact_id": artifact["artifact_id"],
        }],
        artifacts=[artifact],
        required_models=("XGBoost",),
        sidecar_models=(),
    )

    entry = pool["models"]["XGBoost"]
    assert entry["status"] == "active"
    assert entry["rolling_ic"] is None
    assert entry["weekly_ic"] == []
    assert entry["serving_ic_prior"]["value"] == 0.062
    assert entry["serving_ic_prior"]["artifact_version"] == "v2"
    assert entry["serving_ic_prior"]["target_semantic_version"] == resolver.LABEL_SCHEMA_VERSION
