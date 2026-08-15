from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-service"))
sys.path.insert(0, str(ROOT / "ml-controller"))

from app import serving_resolver as modal_resolver  # noqa: E402
from graphs import daily_pipeline_v2 as controller_pipeline  # noqa: E402


def test_controller_manifest_is_accepted_by_modal_without_contract_drift() -> None:
    excluded = {"GNN", "PatchTST"}
    extensions = {
        "LightGBM": "joblib",
        "XGBoost": "joblib",
        "ExtraTrees": "joblib",
        "TabM": "pt",
        "GNN": "pt",
        "DLinear": "pt",
        "PatchTST": "zip",
        "iTransformer": "zip",
    }
    models: dict[str, dict] = {}
    registry_rows: list[dict] = []
    for index, model_name in enumerate(controller_pipeline.ACTIVE_ALPHA_MODELS):
        artifact_id = f"{model_name}:v1:parity"
        artifact_path = (
            f"universal/{model_name.lower()}/v1.{extensions[model_name]}"
        )
        target_semantic = (
            "" if model_name in excluded else controller_pipeline.LABEL_SCHEMA_VERSION
        )
        sequence_contract = None
        if model_name in {"DLinear", "iTransformer"}:
            sequence_contract = {
                "schema_version": "model-serving-sequence-contract-v1",
                "source": "model_artifact_registry",
                "model": model_name,
                "artifact_id": artifact_id,
                "version": "v1",
                "seq_len": 512,
                "pred_len": 5,
            }
        models[model_name] = {
            "status": "active",
            "version": "v1",
            "gcs_path": artifact_path,
            "metadata_path": (
                f"universal/{model_name.lower()}/metadata_v1.json"
            ),
            "serving_artifact_id": artifact_id,
            "serving_eligible": model_name not in excluded,
            "serving_block_reason": (
                "artifact_target_semantic_missing_expected_net-v4"
                if model_name in excluded
                else None
            ),
            "target_semantic_version": target_semantic,
            "sequence_contract": sequence_contract,
        }
        registry_rows.append({
            "artifact_id": artifact_id,
            "model_name": model_name,
            "version": "v1",
            "artifact_path": artifact_path,
            "metadata_path": (
                f"universal/{model_name.lower()}/metadata_v1.json"
            ),
            "checksum": "sha256:" + f"{index + 1:064x}",
            "state": "production",
            "offline_gate_decision": "PASS",
            "live_gate_status": "not_started",
            "metadata_schema_version": "model-artifact-v2",
            "registry_target_semantic_version": target_semantic,
        })

    controller_pool = {
        "models": models,
        "shadow_models": {},
        "formal_layer3_slots": {
            "FormalAudit": {
                "status": "shadow",
                "version": "v1",
                "gcs_path": "audit/formal/v1.json",
                "metadata_path": "audit/formal/metadata_v1.json",
                "artifact_schema": "formal-audit-v1",
                "canonical_source": "controller",
                "direct_prediction": False,
                "vote_weight": 0.0,
                "note": "audit only",
            }
        },
    }
    rank_snapshot = {
        "schema_version": controller_pipeline.PIPELINE_MODAL_RANK_STACKER_SCHEMA,
        "status": "absent",
        "effective_status": "excluded",
        "reason": "artifact_or_metadata_missing",
    }

    manifest, controller_digest = (
        controller_pipeline._build_pipeline_modal_serving_manifest(
            controller_pool,
            registry_rows=registry_rows,
            rank_stacker_snapshot=rank_snapshot,
        )
    )
    modal_pool = modal_resolver.build_pool_from_frozen_manifest(
        manifest,
        expected_digest=controller_digest,
    )

    assert modal_resolver.serving_manifest_digest(manifest) == controller_digest
    assert modal_pool["serving_coverage"]["slot_count"] == 8
    assert modal_pool["serving_coverage"]["serving_model_count"] == 6
    assert [
        row["model"] for row in modal_pool["serving_coverage"]["excluded_models"]
    ] == ["GNN", "PatchTST"]
    assert modal_pool["models"]["GNN"]["status"] == "challenger"
    assert modal_pool["models"]["PatchTST"]["status"] == "challenger"
    assert modal_pool["formal_layer3_slots"]["FormalAudit"]["vote_weight"] == 0.0
    assert modal_pool["rank_stacker"]["effective_status"] == "excluded"
    assert modal_pool["ic_weight_policy"]["source"] == "controller_dispatch_environment"
