from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import serving_resolver as resolver  # noqa: E402


def test_sequence_contract_is_projected_from_exact_registry_artifact():
    artifact_id = "DLinear:vNew:oof_full_fit_release"
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "DLinear",
            "champion_version": "vNew",
            "champion_artifact_id": artifact_id,
        }],
        artifacts=[{
            "artifact_id": artifact_id,
            "model_name": "DLinear",
            "version": "vNew",
            "candidate_type": "oof_full_fit_release",
            "state": "production",
            "artifact_path": "universal/dlinear/vNew.pt",
            "metadata_path": "universal/dlinear/metadata_vNew.json",
            "checksum": "sha256:" + "d" * 64,
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "offline_evidence_json": {
                "registration": {
                    "metadata": {
                        "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                        "seq_len": 512,
                        "pred_len": 5,
                        "rank_ic_semantic_version": resolver.FORMAL_RANK_IC_SEMANTIC_VERSION,
                    }
                }
            },
        }],
        required_models=("DLinear",),
        sidecar_models=(),
    )

    entry = pool["models"]["DLinear"]
    assert entry["status"] == "active"
    assert entry["seq_len"] == 512
    assert entry["pred_len"] == 5
    assert entry["sequence_contract"]["artifact_id"] == artifact_id
    assert entry["sequence_contract"]["version"] == "vNew"
    assert entry["sequence_contract"]["rank_ic_semantic_version"] == resolver.FORMAL_RANK_IC_SEMANTIC_VERSION


def test_sequence_artifact_without_exact_contract_is_not_served():
    pool = resolver.build_pool_from_champion_pointers(
        pointers=[{
            "model_name": "DLinear",
            "champion_version": "vBad",
            "champion_artifact_id": "DLinear:vBad:oof_full_fit_release",
        }],
        artifacts=[{
            "artifact_id": "DLinear:vBad:oof_full_fit_release",
            "model_name": "DLinear",
            "version": "vBad",
            "candidate_type": "oof_full_fit_release",
            "state": "production",
            "artifact_path": "universal/dlinear/vBad.pt",
            "metadata_path": "universal/dlinear/metadata_vBad.json",
            "checksum": "sha256:" + "e" * 64,
            "offline_gate_decision": "STRONG_PASS",
            "live_gate_status": "passed",
            "offline_evidence_json": {
                "registration": {
                    "metadata": {
                        "target_semantic_version": resolver.LABEL_SCHEMA_VERSION,
                    }
                }
            },
        }],
        required_models=("DLinear",),
        sidecar_models=(),
    )

    entry = pool["models"]["DLinear"]
    assert entry["status"] == "degraded"
    assert entry["model_slot_status"] == "active"
    assert entry["serving_eligible"] is False
    assert entry["serving_block_reason"] == "artifact_sequence_contract_missing_or_invalid"
    assert "seq_len" not in entry
    assert "sequence_contract" not in entry
