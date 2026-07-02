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
            "champion_artifact_id": "TabM:vGood:monthly_release",
            "promotion_evidence_json": {"rolling_ic": 0.08},
        }],
        artifacts=[{
            "artifact_id": "TabM:vGood:monthly_release",
            "model_name": "TabM",
            "version": "vGood",
            "candidate_type": "monthly_release",
            "state": "production",
            "artifact_path": "universal/tabm/vGood.pt",
            "metadata_path": "universal/tabm/metadata_vGood.json",
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
        }],
        fallback_pool={"models": {"TabM": {"status": "active", "version": "old"}}},
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
            "champion_artifact_id": "PatchTST:vBad:monthly_release",
        }],
        artifacts=[{
            "artifact_id": "PatchTST:vBad:monthly_release",
            "model_name": "PatchTST",
            "version": "vBad",
            "candidate_type": "monthly_release",
            "state": "production",
            "artifact_path": "universal/patchtst/vBad.zip",
            "offline_gate_decision": "FAIL",
            "live_gate_status": "failed",
        }],
        fallback_pool={
            "models": {
                "PatchTST": {
                    "status": "active",
                    "version": "old",
                    "gcs_path": "universal/patchtst/old.zip",
                },
            },
        },
        required_models=("PatchTST",),
        sidecar_models=(),
    )

    entry = pool["models"]["PatchTST"]
    assert entry["status"] == "retired"
    assert entry["version"] == "vBad"
    assert entry["gcs_path"] == "universal/patchtst/vBad.zip"
    assert entry["serving_block_reason"] == "offline_gate_fail"
