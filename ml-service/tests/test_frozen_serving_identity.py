from __future__ import annotations

import hashlib
import inspect
import io
import json
import sys
from types import SimpleNamespace

import pytest

from app import batch_prediction
from app import dlinear_universal
from app import ensemble
from app import gnn_batch_runtime
from app import neuralforecast_sequence_runtime
from app import prediction_runtime
from app import serving_resolver
from app import tabm_batch_runtime


def _manifest(*, excluded: tuple[str, ...] = ("GNN", "PatchTST")) -> dict:
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
    return {
        "schema_version": serving_resolver.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
        "source_of_truth": "model_champion_pointers/model_artifact_registry",
        "models": [
            {
                "model": model_name,
                "status": "active",
                "effective_status": "challenger" if model_name in excluded else "active",
                "version": "v1",
                "artifact_id": f"{model_name}:v1:test",
                "artifact_path": (
                    f"universal/{model_name.lower()}/v1.{extensions[model_name]}"
                ),
                "metadata_path": (
                    f"registry-metadata/{model_name.lower()}-v1.json"
                ),
                "checksum": "sha256:" + f"{index + 1:064x}",
                "health": {
                    "registry_state": "production",
                    "offline_gate_decision": "PASS",
                    "live_gate_status": "not_started",
                    "serving_eligible": model_name not in excluded,
                    "serving_block_reason": (
                        "artifact_target_semantic_missing_expected_net-v4"
                        if model_name in excluded
                        else None
                    ),
                },
                "schema": {
                    "metadata_schema_version": "test-v1",
                    "target_semantic_version": serving_resolver.LABEL_SCHEMA_VERSION,
                    "feature_semantic_version": serving_resolver.FORMAL_FEATURE_SEMANTIC_VERSION,
                    "gnn_graph_semantic_version": (
                        serving_resolver.FORMAL_GNN_GRAPH_SEMANTIC_VERSION
                        if model_name == "GNN"
                        else None
                    ),
                    "sequence_contract": None,
                },
                "ensemble": {
                    field: None
                    for field in serving_resolver.FROZEN_ENSEMBLE_FIELDS
                },
            }
            for index, model_name in enumerate(serving_resolver.DIRECT_ALPHA_MODELS)
        ],
        "shadow_models": [],
        "formal_layer3_slots": [],
        "rank_stacker": {
            "schema_version": serving_resolver.PIPELINE_MODAL_RANK_STACKER_SCHEMA,
            "status": "absent",
            "effective_status": "excluded",
            "reason": "artifact_or_metadata_missing",
        },
        "ic_weight_policy": {
            "schema_version": "ic-weight-policy-v1",
            "prior_ic": 0.015,
            "prior_strength": 20.0,
            "min_samples_for_hard_zero": 40,
            "source": "controller_dispatch_environment",
        },
    }


def test_frozen_manifest_builds_pool_without_d1_resolution(monkeypatch) -> None:
    manifest = _manifest()
    digest = serving_resolver.serving_manifest_digest(manifest)
    monkeypatch.setattr(
        serving_resolver,
        "load_d1_champion_pool",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("Modal must not resolve a second D1 serving pool")
        ),
    )

    pool = serving_resolver.build_pool_from_frozen_manifest(
        manifest,
        expected_digest=digest,
        l2_sidecar_context={"version": "controller-timesfm-v1"},
    )

    assert pool["source_of_truth"] == "frozen_pipeline_modal_serving_manifest"
    assert pool["serving_manifest_digest"] == digest
    assert pool["models"]["XGBoost"]["serving_artifact_id"] == "XGBoost:v1:test"
    assert pool["models"]["XGBoost"]["metadata_path"] == "registry-metadata/xgboost-v1.json"
    assert pool["l2_feature_sidecars"]["TimesFM"]["status"] == "retired"
    assert pool["serving_coverage"]["slot_count"] == 8
    assert pool["serving_coverage"]["serving_model_count"] == 6
    assert [row["model"] for row in pool["serving_coverage"]["excluded_models"]] == ["GNN", "PatchTST"]
    assert all(row["reason"] for row in pool["serving_coverage"]["excluded_models"])


def test_frozen_manifest_rejects_digest_or_identity_drift() -> None:
    manifest = _manifest()
    digest = serving_resolver.serving_manifest_digest(manifest)
    with pytest.raises(
        serving_resolver.ServingPoolResolutionError,
        match="digest_mismatch",
    ):
        serving_resolver.build_pool_from_frozen_manifest(
            manifest,
            expected_digest="0" * 64,
        )

    tampered = json.loads(json.dumps(manifest))
    tampered["models"][1]["metadata_path"] = "wrong/metadata.json"
    with pytest.raises(
        serving_resolver.ServingPoolResolutionError,
        match="digest_mismatch",
    ):
        serving_resolver.build_pool_from_frozen_manifest(
            tampered,
            expected_digest=digest,
        )


def test_gnn_batch_uses_supplied_frozen_pool_without_resolving(monkeypatch) -> None:
    manifest = _manifest(excluded=())
    pool = serving_resolver.build_pool_from_frozen_manifest(
        manifest,
        expected_digest=serving_resolver.serving_manifest_digest(manifest),
    )

    class Request:
        def __init__(self, **payload):
            self.__dict__.update(payload)

    monkeypatch.setattr(batch_prediction, "PredictRequest", Request)
    monkeypatch.setattr(batch_prediction, "predict_stock_v2", lambda _req: {})
    monkeypatch.setattr(
        batch_prediction,
        "_build_feature_batch_context",
        lambda req: batch_prediction._FeatureBatchContext(
            req=req,
            x_latest=__import__("numpy").array([[1.0]]),
            feature_names=["f1"],
        ),
    )
    monkeypatch.setattr(
        batch_prediction,
        "_load_model_pool",
        lambda: (_ for _ in ()).throw(
            AssertionError("GNN must not resolve another serving pool")
        ),
    )

    def fake_apply(contexts, observed_pool, _model_status):
        assert observed_pool is pool
        for context in contexts:
            context.rank_scores["GNN"] = 0.7

    monkeypatch.setattr(
        batch_prediction,
        "_apply_gnn_batch_context_predictions",
        fake_apply,
    )

    result = batch_prediction.predict_gnn_graphsage_batch(
        [{"symbol": "2330", "stock_id": 2330}],
        pool_snapshot=pool,
    )

    assert result["n_success"] == 1
    assert result["results"][0]["rank_score"] == pytest.approx(0.7)


class _Blob:
    def __init__(self, *, raw: bytes | None = None, text: str | None = None):
        self.raw = raw
        self.text = text

    def exists(self) -> bool:
        return True

    def download_to_file(self, buffer: io.BytesIO) -> None:
        buffer.write(self.raw or b"")

    def download_as_text(self) -> str:
        return self.text or "{}"

    def download_as_bytes(self) -> bytes:
        if self.raw is not None:
            return self.raw
        return (self.text or "").encode("utf-8")


class _Bucket:
    def __init__(self, blobs: dict[str, _Blob]):
        self.blobs = blobs
        self.requested: list[str] = []

    def blob(self, path: str) -> _Blob:
        self.requested.append(path)
        return self.blobs[path]


class _Model:
    def load_state_dict(self, _state) -> None:
        pass

    def eval(self) -> None:
        pass


@pytest.mark.parametrize(
    ("runtime", "model_name", "artifact_path", "metadata_path", "model_type"),
    [
        (
            gnn_batch_runtime,
            "GNN",
            "custom/gnn/release.pt",
            "registry/gnn-meta.json",
            "graphsage",
        ),
        (
            tabm_batch_runtime,
            "TabM",
            "custom/tabm/release.pt",
            "registry/tabm-meta.json",
            "tabular_neural_tabm",
        ),
    ],
)
def test_torch_runtime_uses_registry_metadata_and_checksum_before_deserialization(
    monkeypatch,
    runtime,
    model_name: str,
    artifact_path: str,
    metadata_path: str,
    model_type: str,
) -> None:
    raw = b"immutable-model-bytes"
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    metadata = {
        "model_name": model_name,
        "version": "v-registry",
        "checksum": checksum,
        "model_type": model_type,
        "architecture": {"type": model_type, "n_features": 1},
    }
    bucket = _Bucket({
        artifact_path: _Blob(raw=raw),
        metadata_path: _Blob(text=json.dumps(metadata)),
    })
    pool = {
        "models": {
            model_name: {
                "status": "active",
                "version": "v-registry",
                "gcs_path": artifact_path,
                "metadata_path": metadata_path,
                "checksum": checksum,
                "serving_artifact_id": f"{model_name}:v-registry:test",
                "serving_owner": "frozen_pipeline_modal_serving_manifest",
            }
        }
    }
    load_calls = {"count": 0}

    def fake_torch_load(_buffer, **_kwargs):
        load_calls["count"] += 1
        return {
            "architecture": {"type": model_type, "n_features": 1},
            "state_dict": {},
        }

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(load=fake_torch_load))
    monkeypatch.setattr(runtime, "_get_bucket", lambda: bucket)
    builder_name = (
        "_build_graphsage_ranker"
        if model_name == "GNN"
        else "_build_tabm_ranker"
    )
    monkeypatch.setattr(runtime, builder_name, lambda *_args: _Model())
    runtime.clear_graphsage_artifact_cache() if model_name == "GNN" else runtime.clear_tabm_artifact_cache()

    artifact = (
        runtime.load_graphsage_artifact(pool)
        if model_name == "GNN"
        else runtime.load_tabm_artifact(pool)
    )

    assert artifact.source_path == artifact_path
    assert artifact.metadata["serving_identity_report"]["metadata_path"] == metadata_path
    assert bucket.requested == [artifact_path, metadata_path]
    assert load_calls["count"] == 1


def test_torch_runtime_registry_checksum_mismatch_stops_before_deserialization(
    monkeypatch,
) -> None:
    raw = b"immutable-model-bytes"
    metadata_checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    artifact_path = "custom/gnn/release.pt"
    metadata_path = "registry/gnn-meta.json"
    bucket = _Bucket({
        artifact_path: _Blob(raw=raw),
        metadata_path: _Blob(text=json.dumps({
            "model_name": "GNN",
            "version": "v-registry",
            "checksum": metadata_checksum,
            "model_type": "graphsage",
        })),
    })
    pool = {
        "models": {
            "GNN": {
                "status": "active",
                "version": "v-registry",
                "gcs_path": artifact_path,
                "metadata_path": metadata_path,
                "checksum": "sha256:" + "0" * 64,
                "serving_artifact_id": "GNN:v-registry:test",
                "serving_owner": "frozen_pipeline_modal_serving_manifest",
            }
        }
    }
    load_calls = {"count": 0}
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(load=lambda *_args, **_kwargs: load_calls.__setitem__("count", 1)),
    )
    monkeypatch.setattr(gnn_batch_runtime, "_get_bucket", lambda: bucket)
    gnn_batch_runtime.clear_graphsage_artifact_cache()

    with pytest.raises(RuntimeError, match="registry/metadata checksum mismatch"):
        gnn_batch_runtime.load_graphsage_artifact(pool)

    assert load_calls["count"] == 0



def test_frozen_ic_policy_and_four_scope_weights_match_controller_snapshot(monkeypatch) -> None:
    manifest = _manifest()
    source_pool = {"models": {}}
    for index, row in enumerate(manifest["models"]):
        evidence = {
            field: None for field in serving_resolver.FROZEN_ENSEMBLE_FIELDS
        }
        evidence.update({
            "rolling_ic": 0.02 + index * 0.001,
            "ic_4w_avg": 0.019 + index * 0.001,
            "weekly_ic": [0.018 + index * 0.001, 0.02 + index * 0.001],
            "last_ic_status": "computed",
            "last_ic_root_cause": "ok",
            "last_ic_sample_count": 80,
            "last_ic_by_segment": {
                "LISTED": {"ic": 0.03 + index * 0.001, "sample_count": 70},
                "OTC": {"ic": 0.025 + index * 0.001, "sample_count": 60},
                "EMERGING": {"ic": 0.015 + index * 0.001, "sample_count": 50},
            },
            "last_ic_evaluation_contract": {
                "artifact_version": row["version"],
                "target_semantic_version": serving_resolver.LABEL_SCHEMA_VERSION,
            },
            "last_ic_semantic_version": ensemble.IC_EVALUATION_SEMANTIC_VERSION,
            "last_ic_target_semantic_version": serving_resolver.LABEL_SCHEMA_VERSION,
            "last_ic_artifact_version": row["version"],
        })
        row["ensemble"] = evidence
        source_pool["models"][row["model"]] = {
            "status": row["effective_status"],
            "version": row["version"],
            "target_semantic_version": serving_resolver.LABEL_SCHEMA_VERSION,
            **json.loads(json.dumps(evidence)),
        }

    monkeypatch.setenv("IC_WEIGHT_PRIOR", "0.015")
    monkeypatch.setenv("IC_WEIGHT_PRIOR_STRENGTH", "20")
    monkeypatch.setenv("IC_WEIGHT_MIN_SAMPLES_FOR_HARD_ZERO", "40")
    expected = {
        scope: ensemble._extract_model_pool_ic(source_pool, market_segment=scope)
        for scope in (None, "LISTED", "OTC", "EMERGING")
    }
    frozen_pool = serving_resolver.build_pool_from_frozen_manifest(
        manifest,
        expected_digest=serving_resolver.serving_manifest_digest(manifest),
    )
    monkeypatch.setenv("IC_WEIGHT_PRIOR", "0.9")
    monkeypatch.setenv("IC_WEIGHT_PRIOR_STRENGTH", "999999")
    monkeypatch.setenv("IC_WEIGHT_MIN_SAMPLES_FOR_HARD_ZERO", "0")

    for scope in (None, "LISTED", "OTC", "EMERGING"):
        assert ensemble._extract_model_pool_ic(
            frozen_pool,
            market_segment=scope,
        ) == pytest.approx(expected[scope])
    assert {
        name: entry["status"] for name, entry in frozen_pool["models"].items()
    } == {
        row["model"]: row["effective_status"] for row in manifest["models"]
    }


def test_shadow_and_formal_slots_remain_audit_only() -> None:
    manifest = _manifest()
    manifest["shadow_models"] = [{
        "status": "challenger",
        "version": "v-shadow",
        "gcs_path": "universal/residual_mlp/v-shadow.joblib",
        "metadata_path": "universal/residual_mlp/metadata_v-shadow.json",
        "serving_artifact_id": "ResidualMLP:v-shadow:test",
        "checksum": "sha256:" + "a" * 64,
        "model_type": "residual_mlp",
        "balance_family": "residual",
        "shadow_since": "2026-08-01T00:00:00Z",
        "weekly_ic": [0.01],
        "ic_4w_avg": 0.01,
        "consecutive_negative_weeks": 0,
        "vote_weight": 0.0,
        "model": "ResidualMLP",
    }]
    manifest["formal_layer3_slots"] = [{
        "model": "FormalAudit",
        "status": "shadow",
        "version": "v1",
        "gcs_path": "audit/formal/v1.json",
        "metadata_path": "audit/formal/metadata_v1.json",
        "artifact_schema": "formal-audit-v1",
        "canonical_source": "controller",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "note": "audit only",
    }]
    pool = serving_resolver.build_pool_from_frozen_manifest(
        manifest,
        expected_digest=serving_resolver.serving_manifest_digest(manifest),
    )

    assert batch_prediction._shadow_challenger_names(pool) == ("ResidualMLP",)
    assert pool["shadow_models"]["ResidualMLP"]["vote_weight"] == 0.0
    assert pool["formal_layer3_slots"]["FormalAudit"]["direct_prediction"] is False
    assert pool["formal_layer3_slots"]["FormalAudit"]["vote_weight"] == 0.0


@pytest.mark.parametrize(
    ("field", "value"),
    (("direct_prediction", True), ("vote_weight", 0.1)),
)
def test_formal_slot_vote_tamper_fails(field: str, value) -> None:
    manifest = _manifest()
    row = {
        "model": "FormalAudit",
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
    row[field] = value
    manifest["formal_layer3_slots"] = [row]
    with pytest.raises(
        serving_resolver.ServingPoolResolutionError,
        match="formal_slot_not_audit_only",
    ):
        serving_resolver.build_pool_from_frozen_manifest(
            manifest,
            expected_digest=serving_resolver.serving_manifest_digest(manifest),
        )


def test_exclusion_reason_missing_and_manifest_total_size_fail_closed() -> None:
    manifest = _manifest()
    gnn = next(row for row in manifest["models"] if row["model"] == "GNN")
    gnn["health"]["serving_block_reason"] = None
    with pytest.raises(
        serving_resolver.ServingPoolResolutionError,
        match="exclusion_reason_missing:GNN",
    ):
        serving_resolver.build_pool_from_frozen_manifest(
            manifest,
            expected_digest=serving_resolver.serving_manifest_digest(manifest),
        )

    oversized = _manifest()
    oversized["models"][0]["ensemble"]["weekly_ic"] = ["x" * 1_048_576]
    with pytest.raises(
        serving_resolver.ServingPoolResolutionError,
        match="frozen_serving_manifest_total_bytes",
    ):
        serving_resolver.serving_manifest_digest(oversized)


def test_rank_stacker_has_no_implicit_loader_in_direct_or_frozen_paths() -> None:
    assert "load_meta_learner" not in inspect.getsource(prediction_runtime)
    bundle, audit = batch_prediction._resolve_rank_stacker_runtime({})
    assert bundle is None
    assert audit["effective_status"] == "excluded"
    manifest = _manifest()
    pool = serving_resolver.build_pool_from_frozen_manifest(
        manifest,
        expected_digest=serving_resolver.serving_manifest_digest(manifest),
    )
    bundle, audit = batch_prediction._resolve_rank_stacker_runtime(pool)
    assert bundle is None
    assert audit["effective_status"] == "excluded"


def test_dlinear_prod_shape_uses_exact_identity_and_checksum_before_load(monkeypatch) -> None:
    raw = b"dlinear-immutable-bytes"
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    artifact_path = "universal/dlinear/v20260721104951.pt"
    metadata_path = "universal/dlinear/metadata_v20260721104951.json"
    metadata = {
        "version": "v20260721104951",
        "checksum": checksum,
        "artifact_path": artifact_path,
        "metadata_path": metadata_path,
        "seq_len": 2,
        "pred_len": 1,
        "kernel": 1,
    }
    bucket = _Bucket({
        artifact_path: _Blob(raw=raw),
        metadata_path: _Blob(text=json.dumps(metadata)),
    })
    load_calls = {"count": 0}

    def fake_load(_buffer, **_kwargs):
        load_calls["count"] += 1
        return {}

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(load=fake_load))
    monkeypatch.setattr(dlinear_universal, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(dlinear_universal, "_build_model", lambda *_args: _Model())
    dlinear_universal._MODEL_CACHE.clear()
    identity = {
        "model": "DLinear",
        "version": "v20260721104951",
        "artifact_id": "DLinear:v20260721104951:production",
        "artifact_path": artifact_path,
        "metadata_path": metadata_path,
        "checksum": checksum,
    }

    model, loaded_metadata = dlinear_universal.load_from_gcs(
        identity["version"], artifact_identity=identity
    )

    assert model is not None
    assert loaded_metadata["version"] == identity["version"]
    assert bucket.requested == [artifact_path, metadata_path]
    assert load_calls["count"] == 1

    bad_identity = {**identity, "checksum": "sha256:" + "0" * 64}
    with pytest.raises(ValueError, match="metadata checksum mismatch"):
        dlinear_universal.load_from_gcs(
            identity["version"], artifact_identity=bad_identity
        )
    assert load_calls["count"] == 1


def test_itransformer_uses_exact_registry_paths_and_identity(monkeypatch) -> None:
    raw = b"itransformer-immutable-zip"
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    artifact_path = "universal/itransformer/v20260721104951.zip"
    metadata_path = "universal/itransformer/metadata_v20260721104951.json"
    metadata = {
        "model_name": "iTransformer",
        "version": "v20260721104951",
        "checksum": checksum,
        "artifact_path": artifact_path,
        "metadata_path": metadata_path,
    }
    bucket = _Bucket({
        artifact_path: _Blob(raw=raw),
        metadata_path: _Blob(text=json.dumps(metadata)),
    })
    load_calls = {"count": 0}

    class FakeNeuralForecast:
        @staticmethod
        def load(*, path: str):
            load_calls["count"] += 1
            return {"path": path}

    monkeypatch.setitem(
        sys.modules,
        "neuralforecast",
        SimpleNamespace(NeuralForecast=FakeNeuralForecast),
    )
    monkeypatch.setattr(neuralforecast_sequence_runtime, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(neuralforecast_sequence_runtime, "_configure_neuralforecast_runtime", lambda: None)
    monkeypatch.setattr(neuralforecast_sequence_runtime, "_unzip_bytes", lambda *_args: None)
    neuralforecast_sequence_runtime.clear_neuralforecast_cache()
    identity = {
        "model": "iTransformer",
        "version": "v20260721104951",
        "artifact_id": "iTransformer:v20260721104951:production",
        "artifact_path": artifact_path,
        "metadata_path": metadata_path,
        "checksum": checksum,
    }

    model, loaded_metadata = neuralforecast_sequence_runtime.load_neuralforecast_artifact(
        "iTransformer",
        identity["version"],
        artifact_identity=identity,
    )

    assert model is not None
    assert loaded_metadata["version"] == identity["version"]
    assert bucket.requested == [artifact_path, metadata_path]
    assert load_calls["count"] == 1
from pathlib import Path


def test_modal_runtime_secret_and_bundle_echo_source_sha() -> None:
    source = (
        Path(__file__).resolve().parent.parent / "modal_app.py"
    ).read_text(encoding="utf-8")
    assert '"STOCKVISION_SOURCE_SHA": os.environ.get("STOCKVISION_SOURCE_SHA"' in source
    assert '"STOCKVISION_SOURCE_TREE_SHA": os.environ.get("STOCKVISION_SOURCE_TREE_SHA"' in source
    assert 'modal_source_sha = str(os.environ.get("STOCKVISION_SOURCE_SHA")' in source
    assert '"modal_source_sha": modal_source_sha' in source


def test_modal_source_sha_contract_requires_full_commit() -> None:
    assert len("0123456789abcdef0123456789abcdef01234567") == 40
