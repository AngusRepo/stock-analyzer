from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import batch_prediction, model_pool  # noqa: E402
from app import serving_resolver as resolver  # noqa: E402


ACTIVE8 = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)


def _pool(*, active: tuple[str, ...] = ("XGBoost",)) -> dict:
    return {
        "models": {
            name: {
                "status": "active" if name in active else "retired",
                "version": "v1",
                "gcs_path": f"universal/{name.lower()}/v1.joblib",
                "metadata_path": f"universal/{name.lower()}/metadata_v1.json",
                "serving_artifact_id": f"{name}:v1:test",
                "checksum": "sha256:" + "a" * 64,
                "serving_eligible": True,
            }
            for name in ACTIVE8
        },
        "l2_feature_sidecars": {
            "TimesFM": {
                "status": "active",
                "version": "v1",
                "gcs_path": "universal/timesfm/v1.json",
            }
        },
        "shadow_models": {},
        "formal_layer3_slots": {},
    }


def _joined_xgboost_row() -> dict:
    return {
        "pointer_model_name": "XGBoost",
        "champion_version": "v2",
        "champion_artifact_id": "XGBoost:v2:oof_full_fit_release",
        "promotion_reason": "test",
        "promotion_evidence_json": "{}",
        "pointer_updated_at": "2026-08-14T00:00:00Z",
        "artifact_id": "XGBoost:v2:oof_full_fit_release",
        "artifact_model_name": "XGBoost",
        "artifact_version": "v2",
        "candidate_type": "oof_full_fit_release",
        "state": "production",
        "artifact_path": "universal/xgboost/v2.joblib",
        "metadata_path": "universal/xgboost/metadata_v2.json",
        "checksum": "sha256:" + "b" * 64,
        "offline_gate_decision": "STRONG_PASS",
        "live_gate_status": "passed",
        "live_evidence_json": "{}",
        "offline_evidence_json": (
            '{"registration":{"metadata":{"target_semantic_version":"'
            + resolver.LABEL_SCHEMA_VERSION
            + '"}}}'
        ),
        "artifact_updated_at": "2026-08-14T00:00:00Z",
        "artifact_created_at": "2026-08-14T00:00:00Z",
    }


def test_d1_loader_uses_pointer_bounded_join_and_retries_timeout(monkeypatch):
    calls: list[tuple[str, list, float]] = []

    def fake_query(sql, params, *, timeout):
        calls.append((sql, params, timeout))
        if len(calls) < 3:
            raise RuntimeError("D1 query failed: network error: The read operation timed out")
        return [_joined_xgboost_row()]

    monkeypatch.setenv("MODEL_SERVING_D1_QUERY_ATTEMPTS", "3")
    monkeypatch.setenv("MODEL_SERVING_D1_QUERY_TIMEOUT_SECONDS", "7")
    monkeypatch.setenv("MODEL_SERVING_D1_RETRY_BACKOFF_SECONDS", "0")
    monkeypatch.setattr(resolver, "_query_rows_once", fake_query)

    pool = resolver.load_d1_champion_pool(
        fallback_pool={"models": {}},
        required_models=("XGBoost",),
        sidecar_models=(),
    )

    assert len(calls) == 3
    sql, params, timeout = calls[-1]
    assert "LEFT JOIN model_artifact_registry" in sql
    assert "a.artifact_id = p.champion_artifact_id" in sql
    assert "WHERE p.model_name IN (?)" in sql
    assert "WHERE model_name IS NOT NULL" not in sql
    assert params == ["XGBoost"]
    assert timeout == 7.0
    assert pool["models"]["XGBoost"]["serving_eligible"] is True


def test_d1_loader_preserves_timeout_root_cause_after_bounded_retries(monkeypatch):
    monkeypatch.setenv("MODEL_SERVING_D1_QUERY_ATTEMPTS", "2")
    monkeypatch.setenv("MODEL_SERVING_D1_RETRY_BACKOFF_SECONDS", "0")
    monkeypatch.setattr(
        resolver,
        "_query_rows_once",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("D1 query failed: network error: The read operation timed out")
        ),
    )

    with pytest.raises(
        resolver.ServingPoolResolutionError,
        match=r"d1_timeout: attempts=2: RuntimeError",
    ):
        resolver.load_d1_champion_pool(
            fallback_pool={"models": {}},
            required_models=("XGBoost",),
            sidecar_models=(),
        )


def test_resolved_pool_cache_is_single_entry_and_returns_defensive_copy(monkeypatch):
    calls = {"count": 0}
    now = {"value": 100.0}

    def fake_load(*, fallback_pool=None, **_kwargs):
        calls["count"] += 1
        return {"models": {"XGBoost": {"version": "v2"}}, "fallback": fallback_pool}

    resolver.clear_serving_pool_cache()
    monkeypatch.setenv("CF_API_TOKEN", "test")
    monkeypatch.setenv("CF_ACCOUNT_ID", "test")
    monkeypatch.setenv("CF_D1_DB_ID", "test")
    monkeypatch.setenv("MODEL_SERVING_RESOLVED_POOL_CACHE_TTL_SECONDS", "60")
    monkeypatch.setattr(resolver.time, "monotonic", lambda: now["value"])
    monkeypatch.setattr(resolver, "load_d1_champion_pool", fake_load)
    fallback = {"models": {"XGBoost": {"status": "active"}}}

    first = resolver.resolve_serving_pool(fallback)
    first["models"]["XGBoost"]["version"] = "mutated"
    second = resolver.resolve_serving_pool(fallback)

    assert calls["count"] == 1
    assert second["models"]["XGBoost"]["version"] == "v2"
    resolver.clear_serving_pool_cache()


def test_cold_model_pool_load_preserves_typed_d1_failure(monkeypatch):
    class Blob:
        def exists(self):
            return True

        def download_as_text(self):
            return '{"models":{}}'

    monkeypatch.setattr(model_pool, "_POOL_CACHE", None)
    monkeypatch.setattr(model_pool, "_POOL_CACHE_LOADED_AT", 0.0)
    monkeypatch.setattr(
        model_pool,
        "_get_bucket",
        lambda: SimpleNamespace(blob=lambda _name: Blob()),
    )
    monkeypatch.setattr(
        resolver,
        "resolve_serving_pool",
        lambda _fallback: (_ for _ in ()).throw(
            resolver.ServingPoolResolutionError("d1_timeout: attempts=3")
        ),
    )

    with pytest.raises(resolver.ServingPoolResolutionError, match="d1_timeout"):
        model_pool.load_pool()


def test_batch_tree_loader_reuses_verified_pool_path(monkeypatch):
    from app import ensemble
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY

    class Model:
        def predict(self, values):
            return np.full(values.shape[0], 0.6, dtype=np.float32)

    loaded: list[tuple[str, str | None, bool]] = []
    pool = _pool()
    context = batch_prediction._FeatureBatchContext(
        req=SimpleNamespace(market="TWSE", stock_meta={}, runtime_options={}),
        x_latest=np.array([[1.0]], dtype=np.float32),
        feature_names=["f1"],
    )

    monkeypatch.setattr(batch_prediction, "_build_feature_batch_context", lambda _req: context)
    monkeypatch.setattr(batch_prediction, "_load_model_pool", lambda: pool)
    monkeypatch.setattr(ensemble, "_extract_model_pool_ic", lambda *_args, **_kwargs: {})

    def fake_load(model_name, explicit_path=None, **kwargs):
        loaded.append((model_name, explicit_path, kwargs.get("require_governed_artifact")))
        return Model(), {"feature_names": ["f1"], "feature_medians": {}}

    monkeypatch.setattr(batch_prediction, "_load_feature_artifact", fake_load)
    overrides = batch_prediction._build_feature_model_batch_runtime_overrides([context.req])

    assert loaded == [("XGBoost", "universal/xgboost/v1.joblib", True)]
    assert overrides[0][_BATCH_FEATURE_RANK_SCORES_KEY]["XGBoost"] == pytest.approx(0.6)


def test_preload_filters_lifecycle_and_uses_verified_pool_path(monkeypatch):
    from app import model_store

    loaded: list[tuple[str, str | None, bool]] = []
    pool = _pool()
    monkeypatch.setattr(model_pool, "load_pool", lambda: pool)

    def fake_load(_stock_id, model_name, *, explicit_path=None, **_kwargs):
        loaded.append((
            model_name,
            explicit_path,
            bool(_kwargs.get("require_governed_artifact")),
        ))
        return object(), {}

    monkeypatch.setattr(model_store, "load_model", fake_load)
    result = batch_prediction.preload_batch_artifacts([{"symbol": "2330"}])

    assert loaded == [("XGBoost", "universal/xgboost/v1.joblib", True)]
    assert result["active_attempted"] == 1
    assert result["active_loaded"] == 1
    assert result["errors"] == []


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    (
        ("model_name", "LightGBM", "artifact_model_pointer_mismatch"),
        ("version", "v999", "artifact_version_pointer_mismatch"),
        ("artifact_id", "other-artifact", "artifact_id_pointer_mismatch"),
    ),
)
def test_pointer_artifact_identity_mismatch_fails_closed(field, value, reason):
    pointer = {
        "model_name": "XGBoost",
        "champion_version": "v2",
        "champion_artifact_id": "XGBoost:v2:oof_full_fit_release",
    }
    artifact = {
        "artifact_id": "XGBoost:v2:oof_full_fit_release",
        "model_name": "XGBoost",
        "version": "v2",
        "candidate_type": "oof_full_fit_release",
        "state": "production",
        "artifact_path": "universal/xgboost/v2.joblib",
        "metadata_path": "universal/xgboost/metadata_v2.json",
        "offline_gate_decision": "STRONG_PASS",
        "live_gate_status": "passed",
        "live_evidence_json": "{}",
        "offline_evidence_json": (
            '{"registration":{"metadata":{"target_semantic_version":"'
            + resolver.LABEL_SCHEMA_VERSION
            + '"}}}'
        ),
    }
    artifact[field] = value

    pool = resolver.build_pool_from_champion_pointers(
        pointers=[pointer],
        artifacts=[artifact],
        fallback_pool={"models": {}},
        required_models=("XGBoost",),
        sidecar_models=(),
    )

    entry = pool["models"]["XGBoost"]
    assert entry["serving_eligible"] is False
    assert entry["status"] == "degraded"
    assert entry["serving_block_reason"] == reason


def test_chunked_bundle_resolves_pool_once_and_freezes_same_snapshot(monkeypatch):
    pool = _pool()
    resolution_calls = {"count": 0}
    observed_pool_ids: list[int] = []

    def fake_resolve():
        resolution_calls["count"] += 1
        return pool

    def fake_batch(chunk, *, pool_snapshot=None):
        observed_pool_ids.append(id(pool_snapshot))
        return {
            "results": [
                {"symbol": row["symbol"], "signal": "HOLD"}
                for row in chunk
            ],
            "metrics": {},
        }

    monkeypatch.setattr(batch_prediction, "_load_model_pool", fake_resolve)
    monkeypatch.setattr(batch_prediction, "predict_stock_v2_batch_with_metrics", fake_batch)

    result = batch_prediction.predict_stock_v2_chunked_with_metrics(
        [{"symbol": "2330"}, {"symbol": "2317"}, {"symbol": "2454"}],
        chunk_size=2,
    )

    assert resolution_calls["count"] == 1
    assert observed_pool_ids == [id(pool), id(pool)]
    assert result["chunk_count"] == 2
    assert result["n_input"] == 3
