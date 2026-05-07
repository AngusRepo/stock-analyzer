"""Batch prediction use-case helpers.

This module gives Modal a coarse-grained prediction contract without changing
the single-stock runtime owner. It preserves the same error envelope as
``predict_single_stock`` so downstream pipeline behavior stays stable.
"""
from __future__ import annotations

from typing import Any

PredictRequest: Any = None
predict_stock_v2: Any = None


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


def _get_ft_runtime_cache_stats() -> dict[str, int]:
    try:
        from .ft_transformer import get_ft_runtime_cache_stats

        return get_ft_runtime_cache_stats()
    except Exception:
        return {}


def _stats_delta(after: dict, before: dict) -> dict[str, int]:
    return {
        key: int(after.get(key, 0) or 0) - int(before.get(key, 0) or 0)
        for key in {"hits", "misses", "gcs_downloads"}
    }


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

    active_models = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer"]
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
    results: list[dict] = []
    request_cls, predict_fn = _runtime()
    for payload in payloads or []:
        try:
            req = request_cls(**payload)
            results.append(predict_fn(req))
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not kill the batch.
            results.append({
                "stock_id": payload.get("stock_id", 0),
                "symbol": payload.get("symbol", "?"),
                "error": f"{type(exc).__name__}: {exc}",
                "signal": "NO_SIGNAL",
                "direction": "neutral",
                "confidence": 0.0,
            })
    return results


def predict_stock_v2_batch_with_metrics(payloads: list[dict]) -> dict:
    """Run batch prediction and expose container cache telemetry."""
    before = _get_model_cache_stats()
    ft_before = _get_ft_runtime_cache_stats()
    preload = preload_batch_artifacts(payloads or [])
    after_preload = _get_model_cache_stats()
    results = predict_stock_v2_batch(payloads)
    after = _get_model_cache_stats()
    ft_after = _get_ft_runtime_cache_stats()
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
            "model_cache": {
                **total_delta,
                "preload_delta": _stats_delta(after_preload, before),
                "total_delta": total_delta,
                "after": after,
            },
            "ft_runtime_cache": {
                "hits": int(ft_after.get("hits", 0) or 0) - int(ft_before.get("hits", 0) or 0),
                "misses": int(ft_after.get("misses", 0) or 0) - int(ft_before.get("misses", 0) or 0),
                "after": ft_after,
            },
        },
    }
