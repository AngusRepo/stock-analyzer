from __future__ import annotations

import asyncio
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs import daily_pipeline_v2 as pipeline  # noqa: E402


RUN_DATE = "2026-08-14"
RUN_ID = "pipeline-v2-contract-test"
STATE_URI = "gs://stockvision-models/pipeline-v2/test/partial_state.json"

def _sequence_input_contract(
    *,
    dlinear_symbols: list[str] | None = None,
    itransformer_symbols: list[str] | None = None,
) -> dict:
    core = {
        "schema_version": "pipeline-modal-sequence-input-contract-v1",
        "serving_manifest_digest": pipeline._pipeline_modal_canonical_digest(_manifest()),
        "by_model": {
            "DLinear": {
                "symbols": dlinear_symbols or ["2330", "2317"],
                "sequence_contract": {"seq_len": 64},
            },
            "iTransformer": {
                "symbols": itransformer_symbols or ["2330", "2317"],
                "sequence_contract": {"seq_len": 64},
            },
        },
    }
    return {
        **core,
        "digest": pipeline._pipeline_modal_canonical_digest(core),
    }


SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"


def _manifest() -> dict:
    return {
        "schema_version": pipeline.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
        "source_of_truth": "model_champion_pointers/model_artifact_registry",
        "models": [
            {
                "model": model_name,
                "status": "active",
                "effective_status": "challenger" if model_name in {"GNN", "PatchTST"} else "active",
                "version": "v1",
                "artifact_id": f"{model_name}:v1:test",
                "artifact_path": f"universal/{model_name.lower()}/v1.bin",
                "metadata_path": f"universal/{model_name.lower()}/metadata_v1.json",
                "checksum": "sha256:" + f"{index + 1:064x}",
                "health": {
                    "registry_state": "production",
                    "offline_gate_decision": "PASS",
                    "live_gate_status": "not_started",
                    "serving_eligible": model_name not in {"GNN", "PatchTST"},
                    "serving_block_reason": (
                        "artifact_target_semantic_missing_expected_net-v4"
                        if model_name in {"GNN", "PatchTST"}
                        else None
                    ),
                },
                "schema": {
                    "metadata_schema_version": "model-artifact-v2",
                    "target_semantic_version": pipeline.LABEL_SCHEMA_VERSION,
                    "sequence_contract": None,
                },
            }
            for index, model_name in enumerate(pipeline.ACTIVE_ALPHA_MODELS)
        ],
    }


def _state() -> dict:
    manifest = _manifest()
    return {
        "run_date": RUN_DATE,
        "producer_run_id": RUN_ID,
        "l3_payloads": [
            {"symbol": "2330"},
            {"symbol": "2317"},
        ],
        "pipeline_modal_serving_context": {
            "schema_version": "pipeline-modal-serving-context-v1",
            "model_status": {
                "LightGBM": "active",
                "XGBoost": "active",
                "ExtraTrees": "active",
                "TabM": "active",
                "GNN": "challenger",
                "DLinear": "active",
                "PatchTST": "challenger",
                "iTransformer": "active",
                "ResidualMLP": "challenger",
            },
            "serving_manifest": manifest,
            "serving_manifest_digest": pipeline._pipeline_modal_canonical_digest(manifest),
            "expected_source_sha": SOURCE_SHA,
        },
        "pipeline_modal_sequence_input_contract": _sequence_input_contract(),
        "errors": [],
        "metrics": {},
    }


def _feature_row(symbol: str) -> dict:
    return {
        "symbol": symbol,
        "rank_scores": {
            "LightGBM": 0.51,
            "XGBoost": 0.52,
            "ExtraTrees": 0.53,
            "TabM": 0.54,
        },
    }


def _bundle(*, schema_version: str = "pipeline-modal-prediction-bundle-v1") -> dict:
    manifest = _manifest()
    slot_identities = pipeline._pipeline_modal_manifest_identities(manifest)
    identities = pipeline._pipeline_modal_manifest_identities(manifest, serving_only=True)
    runtime_rows = [
        {"symbol": "2330", "forecast_pct": 0.01},
        {"symbol": "2317", "forecast_pct": 0.02},
    ]
    return {
        "schema_version": schema_version,
        "run_date": RUN_DATE,
        "run_id": RUN_ID,
        "state_gcs_uri": STATE_URI,
        "serving_manifest_digest": pipeline._pipeline_modal_canonical_digest(manifest),
        "active_artifact_identities": identities,
        "slot_artifact_identities": slot_identities,
        "active_artifact_versions": {
            model_name: identity["version"]
            for model_name, identity in identities.items()
        },
        "serving_coverage": pipeline._pipeline_modal_manifest_coverage(manifest),
        "modal_source_sha": SOURCE_SHA,
        "sequence_input_contract": _sequence_input_contract(),
        "n_input": 2,
        "predict_batch_v2_results": [
            _feature_row("2330"),
            _feature_row("2317"),
        ],
        "dlinear_raw": {"results": copy.deepcopy(runtime_rows)},
        "itransformer_raw": {"results": copy.deepcopy(runtime_rows)},
        "gnn_graphsage_raw": {"error": "excluded", "results": []},
        "patchtst_raw": {"error": "excluded", "results": []},
    }


def _callback(bundle: dict) -> dict:
    return {
        "schema_version": "pipeline-modal-prediction-callback-v2",
        "run_date": RUN_DATE,
        "run_id": RUN_ID,
        "state_gcs_uri": STATE_URI,
        "result": bundle,
    }


def test_callback_fails_before_compute_recommend_or_write_on_feature_row_error(monkeypatch) -> None:
    state = _state()
    bundle = _bundle()
    bundle["predict_batch_v2_results"][1] = {
        "symbol": "2317",
        "error": "active_feature_rank_missing:XGBoost",
    }
    downstream_calls: list[list[str]] = []

    monkeypatch.setattr(
        pipeline,
        "_read_pipeline_async_state_artifact",
        lambda _uri: copy.deepcopy(state),
    )

    async def _record_nodes(_state, nodes):
        downstream_calls.append([node.__name__ for node in nodes])
        raise AssertionError("pipeline nodes must not run after bundle preflight failure")

    monkeypatch.setattr(pipeline, "_run_pipeline_nodes", _record_nodes)

    result = asyncio.run(
        pipeline.run_pipeline_v2_from_modal_prediction_callback(_callback(bundle))
    )

    assert result["status"] == "error"
    assert "pipeline_modal_active_feature_closure_failed" in result["error"]
    assert downstream_calls == []


def test_invalid_bundle_schema_cannot_fallback_to_sync_modal(monkeypatch) -> None:
    state = _state()
    downstream_calls: list[list[str]] = []

    monkeypatch.setattr(
        pipeline,
        "_read_pipeline_async_state_artifact",
        lambda _uri: copy.deepcopy(state),
    )

    async def _record_nodes(_state, nodes):
        downstream_calls.append([node.__name__ for node in nodes])
        raise AssertionError("invalid bundle must not enter node_ml_predict fallback")

    monkeypatch.setattr(pipeline, "_run_pipeline_nodes", _record_nodes)
    monkeypatch.setattr(
        pipeline,
        "batch_predict",
        lambda _payloads: (_ for _ in ()).throw(AssertionError("sync Modal fallback invoked")),
    )

    result = asyncio.run(
        pipeline.run_pipeline_v2_from_modal_prediction_callback(
            _callback(_bundle(schema_version="pipeline-modal-prediction-bundle-v0"))
        )
    )

    assert result["status"] == "error"
    assert "pipeline_modal_prediction_bundle_contract:invalid_schema" in result["error"]
    assert downstream_calls == []


@pytest.mark.parametrize(
    ("mutate", "error_marker"),
    [
        (lambda bundle: bundle["predict_batch_v2_results"].pop(), "cardinality_mismatch"),
        (lambda bundle: bundle["predict_batch_v2_results"].append(_feature_row("2330")), "duplicate_symbols"),
        (lambda bundle: bundle["predict_batch_v2_results"].__setitem__(1, _feature_row("9999")), "unexpected_symbols"),
        (lambda bundle: bundle["predict_batch_v2_results"][0]["rank_scores"].pop("XGBoost"), "missing_active_feature_ranks"),
    ],
)
def test_modal_feature_bundle_rejects_symbol_and_active_rank_gaps(mutate, error_marker) -> None:
    bundle = _bundle()
    mutate(bundle)

    with pytest.raises(RuntimeError, match=error_marker):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(_state(), bundle)


def test_modal_feature_bundle_excludes_shadow_models_from_rank_closure() -> None:
    result = pipeline._validate_pipeline_modal_feature_bundle_before_writes(
        _state(),
        _bundle(),
    )

    assert result["required_feature_models"] == [
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
    ]


def _pool_and_registry_rows(*, serving_eligible: bool = True) -> tuple[dict, list[dict]]:
    models = {}
    rows = []
    for index, model_name in enumerate(pipeline.ACTIVE_ALPHA_MODELS):
        artifact_id = f"{model_name}:v1:test"
        artifact_path = f"universal/{model_name.lower()}/v1.bin"
        metadata_path = f"universal/{model_name.lower()}/metadata_v1.json"
        models[model_name] = {
            "status": "active",
            "version": "v1",
            "gcs_path": artifact_path,
            "metadata_path": metadata_path,
            "serving_artifact_id": artifact_id,
            "serving_eligible": serving_eligible if model_name == "XGBoost" else True,
            "serving_block_reason": (
                "test_block" if model_name == "XGBoost" and not serving_eligible else None
            ),
            "target_semantic_version": pipeline.LABEL_SCHEMA_VERSION,
        }
        rows.append({
            "artifact_id": artifact_id,
            "model_name": model_name,
            "version": "v1",
            "artifact_path": artifact_path,
            "metadata_path": metadata_path,
            "checksum": "sha256:" + f"{index + 1:064x}",
            "state": "production",
            "offline_gate_decision": "PASS",
            "live_gate_status": "not_started",
            "metadata_schema_version": "model-artifact-v2",
            "registry_target_semantic_version": pipeline.LABEL_SCHEMA_VERSION,
        })
    return {"models": models}, rows


def test_manifest_excludes_artifact_that_pool_marks_not_serving_eligible() -> None:
    pool, rows = _pool_and_registry_rows(serving_eligible=False)

    manifest, _digest = pipeline._build_pipeline_modal_serving_manifest(
        pool,
        registry_rows=rows,
    )
    xgboost = next(row for row in manifest["models"] if row["model"] == "XGBoost")
    assert xgboost["effective_status"] == "challenger"
    assert xgboost["health"]["serving_block_reason"] == "test_block"
    assert "XGBoost" not in pipeline._pipeline_modal_manifest_identities(manifest, serving_only=True)


def test_callback_rejects_digest_or_artifact_identity_drift_before_writes() -> None:
    state = _state()
    bundle = _bundle()
    bundle["serving_manifest_digest"] = "0" * 64
    with pytest.raises(RuntimeError, match="serving_manifest_digest_mismatch"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)

    bundle = _bundle()
    bundle["active_artifact_identities"]["XGBoost"]["version"] = "v999"
    with pytest.raises(RuntimeError, match="active_artifact_identity_mismatch"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)

def test_callback_rejects_partial_sequence_rows_before_writes() -> None:
    bundle = _bundle()
    bundle["dlinear_raw"]["results"].pop()

    with pytest.raises(RuntimeError, match="pipeline_modal_dlinear_closure_failed"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(_state(), bundle)


def test_callback_accepts_frozen_sequence_eligible_subset() -> None:
    state = _state()
    bundle = _bundle()
    contract = _sequence_input_contract(dlinear_symbols=["2330"])
    state["pipeline_modal_sequence_input_contract"] = contract
    bundle["sequence_input_contract"] = copy.deepcopy(contract)
    bundle["dlinear_raw"]["results"] = [
        row
        for row in bundle["dlinear_raw"]["results"]
        if row["symbol"] == "2330"
    ]

    result = pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)

    assert result["runtime_model_closure"]["DLinear"]["expected_count"] == 1
    assert result["runtime_model_closure"]["DLinear"]["result_count"] == 1


def test_callback_rejects_excluded_reason_and_source_sha_tamper() -> None:
    state = _state()
    bundle = _bundle()
    bundle["serving_coverage"]["excluded_models"][0]["reason"] = "tampered"
    with pytest.raises(RuntimeError, match="serving_coverage_mismatch"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)

    bundle = _bundle()
    bundle["modal_source_sha"] = "f" * 40
    with pytest.raises(RuntimeError, match="modal_source_sha_mismatch"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(state, bundle)


def test_callback_rejects_missing_serving_rank_but_not_excluded_rank() -> None:
    bundle = _bundle()
    bundle["predict_batch_v2_results"][0]["rank_scores"].pop("TabM")
    with pytest.raises(RuntimeError, match="missing_active_feature_ranks"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(_state(), bundle)


def test_rank_stacker_audit_snapshot_failure_is_non_blocking(monkeypatch) -> None:
    monkeypatch.setattr(
        pipeline,
        "_load_pipeline_modal_rank_stacker_snapshot",
        lambda: (_ for _ in ()).throw(TimeoutError("gcs timeout")),
    )

    snapshot = pipeline._pipeline_modal_rank_stacker_snapshot()
    assert snapshot["status"] == "unavailable"
    assert snapshot["effective_status"] == "excluded"
    assert snapshot["reason"] == "audit_snapshot_unavailable:timeouterror"
