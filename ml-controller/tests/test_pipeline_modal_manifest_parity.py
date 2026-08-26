from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-service"))
sys.path.insert(0, str(ROOT / "ml-controller"))

from app import serving_resolver as modal_resolver  # noqa: E402
from graphs import daily_pipeline_v2 as controller_pipeline  # noqa: E402
from test_active8_cutover_contract import _artifact  # noqa: E402


def _pool_and_rows(artifact: dict) -> tuple[dict, list[dict]]:
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
    rows: list[dict] = []
    for model_name in controller_pipeline.ACTIVE_ALPHA_MODELS:
        identity = artifact["base_artifacts"][model_name]
        artifact_path = f"universal/{model_name.lower()}/v-new.{extensions[model_name]}"
        metadata_path = f"universal/{model_name.lower()}/metadata_v-new.json"
        sequence_contract = None
        if model_name in {"DLinear", "iTransformer"}:
            sequence_contract = {
                "schema_version": "model-serving-sequence-contract-v1",
                "source": "model_artifact_registry",
                "model": model_name,
                "artifact_id": identity["artifact_id"],
                "version": identity["version"],
                "seq_len": 512,
                "pred_len": 5,
            }
        models[model_name] = {
            "status": "active",
            "version": identity["version"],
            "gcs_path": artifact_path,
            "metadata_path": metadata_path,
            "serving_artifact_id": identity["artifact_id"],
            "checksum": identity["checksum"],
            "serving_eligible": True,
            "target_semantic_version": controller_pipeline.LABEL_SCHEMA_VERSION,
            "feature_semantic_version": modal_resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
            "gnn_graph_semantic_version": (
                modal_resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION
                if model_name == "GNN"
                else None
            ),
            "sequence_contract": sequence_contract,
        }
        rows.append({
            "artifact_id": identity["artifact_id"],
            "model_name": model_name,
            "version": identity["version"],
            "artifact_path": artifact_path,
            "metadata_path": metadata_path,
            "checksum": identity["checksum"],
            "state": "production",
            "offline_gate_decision": "PASS",
            "live_gate_status": "not_started",
            "metadata_schema_version": "model-artifact-v2",
            "registry_target_semantic_version": controller_pipeline.LABEL_SCHEMA_VERSION,
            "registry_feature_semantic_version": modal_resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
            "registry_gnn_graph_semantic_version": (
                modal_resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION
                if model_name == "GNN"
                else None
            ),
        })
    return {"models": models, "shadow_models": {}, "formal_layer3_slots": {}}, rows


def test_controller_manifest_is_accepted_by_modal_without_contract_drift() -> None:
    artifact = _artifact()
    controller_pool, registry_rows = _pool_and_rows(artifact)

    manifest, controller_digest = controller_pipeline._build_pipeline_modal_serving_manifest(
        controller_pool,
        registry_rows=registry_rows,
        active8_ensemble=artifact,
    )
    modal_pool = modal_resolver.build_pool_from_frozen_manifest(
        manifest,
        expected_digest=controller_digest,
    )

    assert modal_resolver.serving_manifest_digest(manifest) == controller_digest
    assert manifest["source_of_truth"] == "model_champion_pointers+active8_ensemble_pointer_v1"
    assert modal_pool["serving_coverage"]["slot_count"] == 8
    assert modal_pool["serving_coverage"]["serving_model_count"] == 8
    assert modal_pool["serving_coverage"]["excluded_models"] == []
    assert modal_pool["active8_ensemble"]["payload_checksum"] == artifact["payload_checksum"]
    assert set(modal_pool["models"]) == set(controller_pipeline.ACTIVE_ALPHA_MODELS)


def test_manifest_rejects_any_non_serving_base_before_modal_dispatch() -> None:
    artifact = _artifact()
    pool, rows = _pool_and_rows(artifact)
    pool["models"]["XGBoost"]["serving_eligible"] = False
    pool["models"]["XGBoost"]["serving_block_reason"] = "test_block"

    try:
        controller_pipeline._build_pipeline_modal_serving_manifest(
            pool,
            registry_rows=rows,
            active8_ensemble=artifact,
        )
    except RuntimeError as exc:
        assert "active8_base_not_serving:XGBoost:test_block" in str(exc)
    else:
        raise AssertionError("non-serving Active-8 base must block manifest construction")
