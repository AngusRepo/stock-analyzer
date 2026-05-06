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
    try:
        from .model_store import get_model_cache_stats

        before = get_model_cache_stats()
    except Exception:
        before = {}
    results = predict_stock_v2_batch(payloads)
    try:
        from .model_store import get_model_cache_stats

        after = get_model_cache_stats()
    except Exception:
        after = {}
    cache_delta = {
        key: int(after.get(key, 0)) - int(before.get(key, 0))
        for key in {"hits", "misses", "gcs_downloads"}
    }
    return {
        "results": results,
        "metrics": {
            "model_cache": cache_delta,
        },
    }
