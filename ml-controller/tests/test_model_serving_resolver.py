from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import model_serving_resolver as resolver  # noqa: E402


def _fallback_pool() -> dict:
    return {
        "models": {
            name: {"status": "active", "version": "old", "gcs_path": f"legacy/{name}.joblib"}
            for name in resolver.DIRECT_ALPHA_MODELS
        },
        "l2_feature_sidecars": {
            "TimesFM": {"status": "active", "version": "old", "gcs_path": "legacy/timesfm.json"}
        },
    }


def test_build_pool_from_d1_champion_pointer_serves_production_artifact():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vGood",
            "champion_artifact_id": "PatchTST:vGood:weekly_drift",
            "promotion_evidence_json": {
                "rolling_ic": 0.12,
                "last_ic_artifact_version": "vGood",
                "last_ic_target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
            },
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vGood:weekly_drift",
            "model_name": "PatchTST",
            "version": "vGood",
            "candidate_type": "weekly_drift",
            "state": "production",
            "artifact_path": "universal/patchtst/vGood.zip",
            "metadata_path": "universal/patchtst/metadata_vGood.json",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "offline_evidence_json": {
                "registration": {
                    "metadata": {
                        "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                        "seq_len": 512,
                        "pred_len": 5,
                    }
                }
            },
        }],
        fallback_pool=_fallback_pool(),
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert pool["source_of_truth"] == "model_champion_pointers"
    assert entry["status"] == "active"
    assert entry["version"] == "vGood"
    assert entry["gcs_path"] == "universal/patchtst/vGood.zip"
    assert entry["rolling_ic"] == 0.12
    assert entry["target_semantic_version"] == resolver.LABEL_SCHEMA_VERSION
    assert entry["seq_len"] == 512
    assert entry["pred_len"] == 5
    assert entry["sequence_contract"] == {
        "schema_version": "model-serving-sequence-contract-v1",
        "source": "model_artifact_registry",
        "model": "PatchTST",
        "artifact_id": "PatchTST:vGood:weekly_drift",
        "version": "vGood",
        "seq_len": 512,
        "pred_len": 5,
    }


def test_d1_champion_retires_artifact_with_legacy_target_semantic():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "XGBoost",
            "champion_version": "vLegacy",
            "champion_artifact_id": "XGBoost:vLegacy:weekly_drift",
        }],
        artifacts=[{
            "artifact_id": "XGBoost:vLegacy:weekly_drift",
            "model_name": "XGBoost",
            "version": "vLegacy",
            "candidate_type": "weekly_drift",
            "state": "production",
            "artifact_path": "universal/xgboost/vLegacy.joblib",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "offline_evidence_json": {
                "registration": {
                    "metadata": {
                        "target_semantic_version": "next-session-open-to-fifth-session-close-v2",
                    }
                }
            },
        }],
        fallback_pool=_fallback_pool(),
        required_models=("XGBoost",),
        sidecar_models=(),
    )

    entry = pool["models"]["XGBoost"]
    assert entry["status"] == "retired"
    assert entry["serving_block_reason"].startswith("artifact_target_semantic_")


def test_build_pool_from_d1_champion_pointer_retires_archived_or_failed_artifact():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "PatchTST",
            "champion_version": "vBad",
            "champion_artifact_id": "PatchTST:vBad:monthly_release",
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vBad:monthly_release",
            "model_name": "PatchTST",
            "version": "vBad",
            "candidate_type": "monthly_release",
            "state": "archived",
            "artifact_path": "universal/patchtst/vBad.zip",
            "offline_gate_decision": "FAIL",
            "live_gate_status": "failed",
        }],
        fallback_pool=_fallback_pool(),
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert entry["status"] == "retired"
    assert entry["version"] == "vBad"
    assert entry["serving_block_reason"] == "artifact_state_archived"


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
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
        }],
        fallback_pool=_fallback_pool(),
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert entry["status"] == "retired"
    assert entry["version"] == "vLegacy"
    assert entry["serving_block_reason"] == "artifact_extension_pt_expected_zip"


def test_model_pool_reconcile_plan_updates_patchtst_to_d1_champion():
    current_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vBad",
                "gcs_path": "universal/patchtst/vBad.zip",
            }
        }
    }
    champion_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vGood",
                "gcs_path": "universal/patchtst/vGood.zip",
                "metadata_path": "universal/patchtst/metadata_vGood.json",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "PatchTST:vGood:weekly_drift",
            }
        }
    }

    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=current_pool,
        champion_pool=champion_pool,
        model_names=("PatchTST",),
    )

    assert plan["mode"] == "dry_run"
    assert plan["apply_allowed"] is True
    assert plan["action_count"] == 1
    action = plan["actions"][0]
    assert action["action"] == "update_model_pool_pointer"
    assert action["model_name"] == "PatchTST"
    assert action["diff"]["version"] == {"from": "vBad", "to": "vGood"}
    assert action["patch"]["gcs_path"] == "universal/patchtst/vGood.zip"


def test_model_pool_reconcile_plan_clears_stale_serving_block_reason():
    current_pool = {
        "models": {
            "TabM": {
                "status": "active",
                "version": "vGood",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "TabM:vGood:oof_full_fit_release",
                "serving_block_reason": "artifact_target_semantic_missing",
            }
        }
    }
    champion_pool = {
        "models": {
            "TabM": {
                "status": "active",
                "version": "vGood",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "TabM:vGood:oof_full_fit_release",
                "serving_block_reason": None,
            }
        }
    }

    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=current_pool,
        champion_pool=champion_pool,
        model_names=("TabM",),
    )

    assert plan["action_count"] == 1
    assert plan["actions"][0]["diff"]["serving_block_reason"] == {
        "from": "artifact_target_semantic_missing",
        "to": None,
    }
    patched = resolver.apply_model_pool_reconcile_plan(model_pool=current_pool, plan=plan)
    assert patched["models"]["TabM"]["serving_block_reason"] is None


def test_model_pool_reconcile_plan_retires_archived_d1_champion_pointer():
    plan = resolver.build_model_pool_reconcile_plan(
        model_pool={"models": {"PatchTST": {"status": "active", "version": "vBad"}}},
        champion_pool={
            "models": {
                "PatchTST": {
                    "status": "retired",
                    "version": "vBad",
                    "serving_block_reason": "artifact_state_archived",
                }
            }
        },
        model_names=("PatchTST",),
    )

    assert plan["apply_allowed"] is True
    assert plan["blocked"] == []
    assert plan["action_count"] == 1
    assert plan["actions"][0]["action"] == "retire_invalid_model_pool_pointer"
    assert plan["actions"][0]["patch"] == {
        "version": "vBad",
        "status": "retired",
        "production_weight": 0.0,
        "serving_owner": None,
        "serving_artifact_id": None,
        "serving_block_reason": "artifact_state_archived",
        "seq_len": None,
        "pred_len": None,
        "sequence_contract": None,
    }

    patched = resolver.apply_model_pool_reconcile_plan(
        model_pool={"models": {"PatchTST": {"status": "active", "version": "vBad"}}},
        plan=plan,
    )
    assert patched["models"]["PatchTST"]["status"] == "retired"
    assert patched["models"]["PatchTST"]["production_weight"] == 0.0
    assert patched["models"]["PatchTST"]["serving_block_reason"] == "artifact_state_archived"


def test_apply_model_pool_reconcile_plan_updates_stale_compat_artifact_id():
    current_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vGood",
                "gcs_path": "universal/patchtst/vGood.zip",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "PatchTST:vOld:weekly_drift",
            }
        }
    }
    champion_pool = {
        "models": {
            "PatchTST": {
                "status": "active",
                "version": "vGood",
                "gcs_path": "universal/patchtst/vGood.zip",
                "metadata_path": "universal/patchtst/metadata_vGood.json",
                "serving_owner": "model_champion_pointers",
                "serving_artifact_id": "PatchTST:vGood:weekly_drift",
            }
        }
    }
    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=current_pool,
        champion_pool=champion_pool,
        model_names=("PatchTST",),
    )

    patched = resolver.apply_model_pool_reconcile_plan(model_pool=current_pool, plan=plan)

    assert patched["models"]["PatchTST"]["serving_artifact_id"] == "PatchTST:vGood:weekly_drift"
    assert patched["models"]["PatchTST"]["version"] == "vGood"
    assert patched["source_of_truth"] == "model_champion_pointers"
    assert patched["reconcile_evidence"]["applied_count"] == 1


def test_oof_prior_quarantines_stale_fallback_ic_and_reconcile_repairs_pool():
    artifact = {
        "artifact_id": "XGBoost:vGood:oof_full_fit_release",
        "model_name": "XGBoost",
        "version": "vGood",
        "candidate_type": "oof_full_fit_release",
        "state": "production",
        "artifact_path": "universal/xgboost/vGood.joblib",
        "offline_gate_decision": "STRONG_PASS",
        "live_gate_status": "promoted",
        "offline_evidence_json": {
            "registration": {
                "metadata": {
                    "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                    "sample_count": 1000,
                    "model_cpcv": {
                        "method": "outer_purged_walk_forward_rank_ic",
                        "decision": "PASS",
                        "passed": True,
                        "oos_ic_mean": 0.0617,
                        "folds": 5,
                        "positive_fold_ratio": 0.6,
                    },
                }
            }
        },
    }
    stale_pool = {
        "models": {
            "XGBoost": {
                "status": "active",
                "version": "vGood",
                "rolling_ic": -0.09,
                "ic_4w_avg": -0.08,
                "weekly_ic": [-0.09],
                "last_ic_semantic_version": "daily-cross-sectional-equal-date-v2",
                "last_ic_evaluation_contract": {
                    "target_semantic_version": "next-session-open-to-fifth-session-close-v2",
                },
            }
        }
    }
    champion_pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "XGBoost",
            "champion_version": "vGood",
            "champion_artifact_id": artifact["artifact_id"],
        }],
        artifacts=[artifact],
        fallback_pool=stale_pool,
        required_models=("XGBoost",),
        sidecar_models=(),
    )

    champion = champion_pool["models"]["XGBoost"]
    assert champion["rolling_ic"] is None
    assert champion["weekly_ic"] == []
    assert champion["serving_ic_prior"]["value"] == 0.0617
    assert champion["serving_ic_prior"]["artifact_version"] == "vGood"

    plan = resolver.build_model_pool_reconcile_plan(
        model_pool=stale_pool,
        champion_pool=champion_pool,
        model_names=("XGBoost",),
    )
    repaired = resolver.apply_model_pool_reconcile_plan(model_pool=stale_pool, plan=plan)
    entry = repaired["models"]["XGBoost"]
    assert entry["rolling_ic"] is None
    assert entry["ic_4w_avg"] is None
    assert entry["weekly_ic"] == []
    assert entry["serving_ic_prior"]["source"] == "candidate_scoped_purged_oof_model_cpcv"
