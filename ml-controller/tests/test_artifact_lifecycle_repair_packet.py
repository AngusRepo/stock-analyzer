from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.artifact_lifecycle_repair_packet import build_artifact_lifecycle_repair_packet  # noqa: E402


def test_repair_packet_separates_coverage_recompute_from_true_performance_fail():
    packet = build_artifact_lifecycle_repair_packet(
        {
            "schema_version": "stockvision-production-retrain-release-evidence-v1",
            "run": {
                "run_id": "universal-20260621T231108-40d3a660",
                "candidate_version": "v20260621154455",
                "status": "completed",
                "is_monthly": True,
            },
            "training": {
                "ic_summary": {
                    "LightGBM": 0.0912,
                    "DLinear": 0.0406,
                },
            },
            "artifact_lifecycle": {
                "artifacts": {
                    "PatchTST": {
                        "version": "v20260621154455",
                        "path": "universal/patchtst/v20260621154455.zip",
                        "oos_ic": 0.296486,
                        "offline_gate_decision": "FAIL",
                        "model_cpcv_decision": "FAIL",
                        "production_pointer_updated": True,
                    },
                    "iTransformer": {
                        "version": "v20260621154455",
                        "path": "universal/itransformer/v20260621154455.zip",
                        "oos_ic": -0.058854,
                        "offline_gate_decision": "FAIL",
                        "model_cpcv_decision": "FAIL",
                        "production_pointer_updated": True,
                    },
                    "GNN": {
                        "version": "v20260621154455",
                        "path": "universal/gnn/v20260621154455.pt",
                        "oos_ic": 0.084899,
                        "offline_gate_decision": "STRONG_PASS",
                        "production_pointer_updated": True,
                    },
                },
            },
            "model_pool_release": {
                "models_kept_at_previous_version": {
                    "LightGBM": "v20260619014016",
                    "DLinear": "v20260619014016",
                },
            },
        },
        generated_at="2026-06-22T00:00:00+00:00",
    )

    by_model = {action["model_name"]: action for action in packet["actions"]}
    assert packet["production_mutation_allowed"] is False
    assert packet["summary"]["production_pointer_fail_closed_repairs"] == ["PatchTST", "iTransformer"]
    assert set(packet["summary"]["offline_pass_pending_release"]) == {"DLinear", "LightGBM"}
    assert by_model["PatchTST"]["root_cause"] == "production_pointer_updated_despite_cpcv_coverage_contract_drift"
    assert by_model["iTransformer"]["root_cause"] == "production_pointer_updated_despite_true_performance_fail"
    assert by_model["DLinear"]["root_cause"] == "offline_pass_candidate_not_released_to_model_pool"
    assert all(action["requires_wei_approval"] is True for action in packet["actions"])
    assert all(action["production_mutation_allowed"] is False for action in packet["actions"])
