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
            "promotion_evidence_json": {"rolling_ic": 0.12},
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
    assert plan["apply_allowed"] is False
    assert plan["action_count"] == 1
    action = plan["actions"][0]
    assert action["action"] == "update_model_pool_pointer"
    assert action["model_name"] == "PatchTST"
    assert action["diff"]["version"] == {"from": "vBad", "to": "vGood"}
    assert action["patch"]["gcs_path"] == "universal/patchtst/vGood.zip"


def test_model_pool_reconcile_plan_blocks_archived_d1_champion():
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

    assert plan["action_count"] == 0
    assert plan["blocked"] == [{
        "model_name": "PatchTST",
        "reason": "artifact_state_archived",
        "section": "models",
        "champion_version": "vBad",
    }]
