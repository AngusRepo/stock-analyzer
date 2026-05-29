"""Batch prediction use-case helpers.

This module gives Modal a coarse-grained prediction contract without changing
the single-stock runtime owner. It preserves the same error envelope as
``predict_single_stock`` so downstream pipeline behavior stays stable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import os
import time
from typing import Any

import numpy as np

PredictRequest: Any = None
predict_stock_v2: Any = None


@dataclass
class _FeatureBatchContext:
    req: Any
    x_latest: np.ndarray
    feature_names: list[str]
    rank_scores: dict[str, float] = field(default_factory=dict)
    model_errors: list[str] = field(default_factory=list)
    challenger_rank_scores: dict[str, float] = field(default_factory=dict)
    challenger_errors: list[str] = field(default_factory=list)


def _runtime():
    global PredictRequest, predict_stock_v2
    if PredictRequest is None:
        from .schemas import PredictRequest as _PredictRequest
        PredictRequest = _PredictRequest
    if predict_stock_v2 is None:
        from .prediction_runtime import predict_stock_v2 as _predict_stock_v2
        predict_stock_v2 = _predict_stock_v2
    return PredictRequest, predict_stock_v2


def _get_model_cache_stats() -> dict[str, int]:
    try:
        from .model_store import get_model_cache_stats

        return get_model_cache_stats()
    except Exception:
        return {}


def _stats_delta(after: dict, before: dict) -> dict[str, int]:
    return {
        key: int(after.get(key, 0) or 0) - int(before.get(key, 0) or 0)
        for key in {"hits", "misses", "gcs_downloads"}
    }


def _true_batch_enabled() -> bool:
    return str(os.environ.get("PREDICT_BATCH_V2_TRUE_BATCH", "1")).strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _is_real_runtime(request_cls: Any, predict_fn: Any) -> bool:
    """Avoid surprising tests or callers that monkeypatch the runtime boundary."""
    return (
        getattr(request_cls, "__module__", "").endswith(".schemas")
        and getattr(predict_fn, "__module__", "").endswith(".prediction_runtime")
    )


def _load_model_pool() -> dict | None:
    from .model_pool import load_pool

    return load_pool()


def _get_pool_challenger_path(model_name: str, pool: dict | None) -> str | None:
    from .model_pool import get_challenger_path

    return get_challenger_path(model_name, pool=pool)


def _load_feature_artifact(model_name: str, explicit_path: str | None = None) -> tuple[Any, dict | None]:
    from .model_store import load_model

    return load_model(0, model_name, explicit_path=explicit_path)


def _build_feature_batch_context(req: Any) -> _FeatureBatchContext:
    from .features import build_feature_matrix, get_features

    chips_input = req.chips if req.market.upper() not in ("US", "NYSE", "NASDAQ") else []
    df = build_feature_matrix(
        req.prices,
        req.indicators,
        chips_input,
        req.sentiment_scores,
        req.market_env,
        barrier_params=req.barrier_params or None,
        stock_meta=getattr(req, "stock_meta", None),
    )
    x, _y, feature_names = get_features(df, target_col="target_rank", allow_missing_target=True)
    if len(x) == 0:
        raise ValueError(f"Feature matrix empty for {req.symbol}")
    return _FeatureBatchContext(
        req=req,
        x_latest=x[-1].reshape(1, -1),
        feature_names=feature_names,
    )


def _align_latest_features(ctx: _FeatureBatchContext, meta: dict | None) -> np.ndarray:
    from .artifact_contract import ArtifactValidationError, validate_serving_feature_compatibility
    from .features import safe_float

    training_features = (meta or {}).get("feature_names", [])
    training_medians = (meta or {}).get("feature_medians", {})
    if training_features and training_features != ctx.feature_names:
        try:
            validate_serving_feature_compatibility(
                training_features=training_features,
                serving_features=ctx.feature_names,
                feature_medians=training_medians,
            )
        except ArtifactValidationError as exc:
            raise ValueError(f"artifact feature compatibility failed: {exc.report}") from exc
        pred_name_to_idx = {name: idx for idx, name in enumerate(ctx.feature_names)}
        defaults = np.array(
            [safe_float(training_medians.get(name), 0.0) for name in training_features],
            dtype=np.float32,
        ).reshape(1, -1)
        aligned = defaults.copy()
        for idx, fname in enumerate(training_features):
            if fname in pred_name_to_idx:
                aligned[0, idx] = float(ctx.x_latest[0, pred_name_to_idx[fname]])
        return aligned
    return ctx.x_latest


def _clip_rank(value: Any) -> float:
    return float(np.clip(float(value), 0.0, 1.0))


def _record_feature_score(
    ctx: _FeatureBatchContext,
    model_name: str,
    score: Any,
    *,
    challenger: bool = False,
) -> None:
    target = ctx.challenger_rank_scores if challenger else ctx.rank_scores
    target[model_name] = _clip_rank(score)


def _record_feature_error(
    ctx: _FeatureBatchContext,
    message: str,
    *,
    challenger: bool = False,
) -> None:
    target = ctx.challenger_errors if challenger else ctx.model_errors
    target.append(message)


def _apply_artifact_batch_predictions(
    contexts: list[_FeatureBatchContext],
    model_name: str,
    model_obj: Any,
    meta: dict | None,
    *,
    challenger: bool = False,
) -> None:
    rows: list[tuple[_FeatureBatchContext, np.ndarray]] = []
    for ctx in contexts:
        try:
            rows.append((ctx, _align_latest_features(ctx, meta)))
        except Exception as exc:  # noqa: BLE001 - keep one bad symbol/model local.
            prefix = "challenger " if challenger else ""
            _record_feature_error(ctx, f"{model_name}: {prefix}{exc}", challenger=challenger)
    if not rows:
        return

    x_batch = np.vstack([row for _ctx, row in rows])
    try:
        preds = np.asarray(model_obj.predict(x_batch)).reshape(-1)
        for (ctx, _row), pred in zip(rows, preds):
            _record_feature_score(ctx, model_name, pred, challenger=challenger)
    except Exception as batch_exc:  # noqa: BLE001
        prefix = "challenger " if challenger else ""
        for ctx, x_row in rows:
            try:
                pred = np.asarray(model_obj.predict(x_row)).reshape(-1)[0]
                _record_feature_score(ctx, model_name, pred, challenger=challenger)
            except Exception as row_exc:  # noqa: BLE001
                _record_feature_error(
                    ctx,
                    f"{model_name}: {prefix}{type(batch_exc).__name__}: {batch_exc}; row fallback: {row_exc}",
                    challenger=challenger,
                )


def _model_pool_status(pool: dict | None) -> dict[str, str]:
    from .prediction_runtime import _MODEL_NAMES_V2

    pool_models = (pool or {}).get("models", {}) if pool else {}
    return {
        name: (pool_models.get(name) or {}).get("status", "active")
        for name in _MODEL_NAMES_V2
    }


def _build_feature_model_batch_runtime_overrides(requests: list[Any]) -> list[dict]:
    from .prediction_runtime import (
        _BATCH_CHALLENGER_MODEL_ERRORS_KEY,
        _BATCH_CHALLENGER_RANK_SCORES_KEY,
        _BATCH_FEATURE_MODEL_ERRORS_KEY,
        _BATCH_FEATURE_RANK_SCORES_KEY,
        _FEATURE_MODEL_NAMES_V2,
    )

    contexts = [_build_feature_batch_context(req) for req in requests]
    pool = _load_model_pool()
    model_status = _model_pool_status(pool)

    for model_name in _FEATURE_MODEL_NAMES_V2:
        status = model_status.get(model_name, "active")
        if status in ("retired", "challenger"):
            for ctx in contexts:
                _record_feature_error(ctx, f"{model_name}: skipped by model_pool status={status}")
            continue
        try:
            model_obj, meta = _load_feature_artifact(model_name)
        except Exception as exc:  # noqa: BLE001
            for ctx in contexts:
                _record_feature_error(ctx, f"{model_name}: {exc}")
            continue
        if model_obj is None:
            for ctx in contexts:
                _record_feature_error(ctx, f"{model_name}: not found in GCS")
            continue
        _apply_artifact_batch_predictions(contexts, model_name, model_obj, meta)

    if pool:
        for model_name in _FEATURE_MODEL_NAMES_V2:
            try:
                ch_path = _get_pool_challenger_path(model_name, pool=pool)
            except Exception as exc:  # noqa: BLE001
                for ctx in contexts:
                    _record_feature_error(ctx, f"{model_name}: challenger {exc}", challenger=True)
                continue
            if not ch_path:
                continue
            try:
                model_obj, meta = _load_feature_artifact(model_name, explicit_path=ch_path)
            except Exception as exc:  # noqa: BLE001
                for ctx in contexts:
                    _record_feature_error(ctx, f"{model_name}: challenger {exc}", challenger=True)
                continue
            if model_obj is None:
                for ctx in contexts:
                    _record_feature_error(
                        ctx,
                        f"{model_name}: challenger artifact missing at {ch_path}",
                        challenger=True,
                    )
                continue
            _apply_artifact_batch_predictions(contexts, model_name, model_obj, meta, challenger=True)

    return [
        {
            _BATCH_FEATURE_RANK_SCORES_KEY: dict(ctx.rank_scores),
            _BATCH_FEATURE_MODEL_ERRORS_KEY: list(ctx.model_errors),
            _BATCH_CHALLENGER_RANK_SCORES_KEY: dict(ctx.challenger_rank_scores),
            _BATCH_CHALLENGER_MODEL_ERRORS_KEY: list(ctx.challenger_errors),
        }
        for ctx in contexts
    ]


def _copy_request_with_runtime_overrides(req: Any, overrides: dict) -> Any:
    runtime_options = dict(getattr(req, "runtime_options", {}) or {})
    runtime_options.update(overrides)
    if hasattr(req, "model_copy"):
        return req.model_copy(update={"runtime_options": runtime_options})
    copied = req.__class__(**getattr(req, "__dict__", {}))
    copied.runtime_options = runtime_options
    return copied


def _error_result(payload: dict, exc: Exception) -> dict:
    return {
        "stock_id": payload.get("stock_id", 0),
        "symbol": payload.get("symbol", "?"),
        "error": f"{type(exc).__name__}: {exc}",
        "signal": "NO_SIGNAL",
        "direction": "neutral",
        "confidence": 0.0,
    }


def _predict_serial(payloads: list[dict], request_cls: Any, predict_fn: Any) -> list[dict]:
    results: list[dict] = []
    for payload in payloads or []:
        try:
            req = request_cls(**payload)
            results.append(predict_fn(req))
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the batch.
            results.append(_error_result(payload, exc))
    return results


def preload_batch_artifacts(payloads: list[dict]) -> dict:
    """Warm container-local artifact cache once before the per-symbol loop."""
    if not payloads:
        return {
            "active_attempted": 0,
            "active_loaded": 0,
            "challenger_attempted": 0,
            "challenger_loaded": 0,
            "errors": [],
        }

    active_models = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]
    errors: list[str] = []
    active_loaded = 0
    challenger_loaded = 0
    challenger_attempted = 0

    try:
        from .model_store import load_model
        from .model_pool import get_challenger_path, load_pool
    except Exception as exc:  # noqa: BLE001 - telemetry must not block prediction.
        return {
            "active_attempted": len(active_models),
            "active_loaded": 0,
            "challenger_attempted": 0,
            "challenger_loaded": 0,
            "errors": [f"preload_import_failed: {type(exc).__name__}: {exc}"],
        }

    for model_name in active_models:
        try:
            model_obj, _meta = load_model(0, model_name)
            if model_obj is not None:
                active_loaded += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{model_name}: {type(exc).__name__}: {exc}")

    try:
        pool = load_pool() or {}
    except Exception as exc:  # noqa: BLE001
        pool = {}
        errors.append(f"model_pool: {type(exc).__name__}: {exc}")

    for model_name in active_models:
        try:
            ch_path = get_challenger_path(model_name, pool=pool) if pool else None
            if not ch_path:
                continue
            challenger_attempted += 1
            model_obj, _meta = load_model(0, model_name, explicit_path=ch_path)
            if model_obj is not None:
                challenger_loaded += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{model_name} challenger: {type(exc).__name__}: {exc}")

    return {
        "active_attempted": len(active_models),
        "active_loaded": active_loaded,
        "challenger_attempted": challenger_attempted,
        "challenger_loaded": challenger_loaded,
        "errors": errors,
    }


def predict_stock_v2_batch(payloads: list[dict]) -> list[dict]:
    request_cls, predict_fn = _runtime()
    if not payloads:
        return []
    if not _true_batch_enabled() or not _is_real_runtime(request_cls, predict_fn):
        return _predict_serial(payloads, request_cls, predict_fn)

    requests_by_position: dict[int, Any] = {}
    results: list[dict | None] = [None] * len(payloads)
    for idx, payload in enumerate(payloads):
        try:
            requests_by_position[idx] = request_cls(**payload)
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the batch.
            results[idx] = _error_result(payload, exc)

    valid_positions = list(requests_by_position)
    if valid_positions:
        valid_requests = [requests_by_position[idx] for idx in valid_positions]
        try:
            overrides_by_request = _build_feature_model_batch_runtime_overrides(valid_requests)
            valid_requests = [
                _copy_request_with_runtime_overrides(req, overrides)
                for req, overrides in zip(valid_requests, overrides_by_request)
            ]
        except Exception:
            # The serial owner remains the correctness fallback for unexpected
            # artifact/schema drift. Per-symbol error wrapping still applies.
            valid_requests = [requests_by_position[idx] for idx in valid_positions]

        for idx, req in zip(valid_positions, valid_requests):
            try:
                results[idx] = predict_fn(req)
            except Exception as exc:  # noqa: BLE001
                results[idx] = _error_result(payloads[idx], exc)

    return [result for result in results if result is not None]


def predict_stock_v2_batch_with_metrics(payloads: list[dict]) -> dict:
    """Run batch prediction and expose container cache telemetry."""
    before = _get_model_cache_stats()
    preload_t0 = time.time()
    preload = preload_batch_artifacts(payloads or [])
    preload_elapsed_s = round(time.time() - preload_t0, 3)
    after_preload = _get_model_cache_stats()
    predict_t0 = time.time()
    results = predict_stock_v2_batch(payloads)
    predict_elapsed_s = round(time.time() - predict_t0, 3)
    after = _get_model_cache_stats()
    total_delta = _stats_delta(after, before)
    return {
        "results": results,
        "metrics": {
            "batch": {
                "n_input": len(payloads or []),
                "n_error": sum(1 for r in results if r.get("error")),
                "contract": "modal_predict_batch_v2_true_batch",
            },
            "preload": preload,
            "timing": {
                "preload_elapsed_s": preload_elapsed_s,
                "predict_loop_elapsed_s": predict_elapsed_s,
                "total_elapsed_s": round(preload_elapsed_s + predict_elapsed_s, 3),
            },
            "model_cache": {
                **total_delta,
                "preload_delta": _stats_delta(after_preload, before),
                "total_delta": total_delta,
                "after": after,
            },
        },
    }
