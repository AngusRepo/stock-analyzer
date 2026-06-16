"""
state_space_universal.py — Batch wrapper for per-stock state-space models.

KalmanFilter + MarkovSwitching run inside the v2 universal pipeline as
state-space overlays:
  - They provide regime/risk context per stock.
  - They do not vote as alpha predictors.
  - They do not enter alpha IC, challenger shadow, or promotion lifecycle.
  - Shared hyperparameter versions are tracked under model_pool.state_overlays.

Architecture constraint: state-space models can't do tensor-batch inference
(each stock has its own latent state). The batch wrapper here calls the
existing models.py:run_kalman_filter / run_markov_switching once per stock,
using bounded per-symbol concurrency for heavy overlays, BUT:
  - Hyperparameters loaded ONCE from GCS shared file (not per-call)
  - Fit parameters, validation loops, and output schema stay unchanged
  - executor.map preserves input order for downstream overlay attachment

Output schema (matches Chronos/DLinear/PatchTST batch predictors):
  [{"symbol", "model", "forecast_pct", "up_prob", "confidence", "direction",
    "model_version"}]
  or {"symbol", "error"} on failure.
"""
from __future__ import annotations
import os
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Callable, Optional

import numpy as np

logger = logging.getLogger(__name__)

# Min context for state-space (Kalman handles short series gracefully but
# Markov-Switching runner requires 60 prices before fitting; keep the batch
# gate aligned so insufficient series are not logged as fallback successes.
_MIN_CONTEXT = {
    "KalmanFilter":    10,
    "MarkovSwitching": 60,
}

_DEFAULT_MAX_WORKERS = {
    "KalmanFilter": 1,
    "MarkovSwitching": 1,
}


@lru_cache(maxsize=4)
def _load_hyperparams(model_name: str, version: str) -> dict:
    """Module-cached hyperparam load (one shot per container lifetime per version).

    Serving hyperparams are artifact-required; missing GCS rows make the overlay
    return per-symbol errors instead of defaulting into synthetic output.
    """
    from .model_pool import load_state_space_hyperparams
    return load_state_space_hyperparams(model_name, version)


def _to_dict_shape(result, model_name: str, symbol: str, version: str) -> dict:
    """Map ModelPrediction (from models.py) to the unified batch dict shape."""
    # ModelPrediction has: model_name, direction, confidence, forecast_pct,
    # forecasts (list of dicts with date/forecast/lower/upper), direction_accuracy
    forecast_pct = float(getattr(result, "forecast_pct", 0.0) or 0.0)
    direction = getattr(result, "direction", "neutral")
    confidence = float(getattr(result, "confidence", 0.5))
    # Derive up_prob from direction + confidence (mirror Chronos heuristic)
    if direction == "up":
        up_prob = confidence
    elif direction == "down":
        up_prob = 1.0 - confidence
    else:
        up_prob = 0.5
    return {
        "symbol": symbol,
        "model": model_name,
        "forecast_pct": round(forecast_pct, 4),
        "up_prob": round(up_prob, 3),
        "confidence": round(confidence, 3),
        "direction": direction,
        "model_version": version,
        "n_used": int(getattr(result, "_n_used", 0)) if hasattr(result, "_n_used") else None,
        "degraded": bool(getattr(result, "degraded", False)),
        "fallback_reason": getattr(result, "fallback_reason", None),
        "diagnostics": getattr(result, "diagnostics", None),
    }


def _max_workers_for_model(model_name: str, n_items: int, override: int | None = None) -> int:
    """Return bounded per-symbol concurrency without changing model spec."""
    if n_items <= 1:
        return 1
    if override is not None:
        configured = int(override)
    else:
        env_key = f"STATE_SPACE_{model_name.upper()}_MAX_WORKERS"
        raw = os.environ.get(env_key) or os.environ.get("STATE_SPACE_MAX_WORKERS")
        try:
            configured = int(raw) if raw is not None else _DEFAULT_MAX_WORKERS.get(model_name, 1)
        except (TypeError, ValueError):
            configured = _DEFAULT_MAX_WORKERS.get(model_name, 1)
    return max(1, min(int(configured), int(n_items)))


def _predict_one_state_space(
    *,
    row: dict,
    model_name: str,
    horizon: int,
    version: str,
    min_n: int,
    hyperparams: dict,
    runner: Callable,
) -> dict:
    symbol = row.get("symbol", "?")
    prices = row.get("prices") or []
    if len(prices) < min_n:
        return {
            "symbol": symbol,
            "error": f"insufficient data ({len(prices)} < {min_n})",
        }
    try:
        arr = np.asarray(prices, dtype=np.float64)
        pred = runner(arr, horizon=horizon, stock_id=0, hyperparams=hyperparams)
        return _to_dict_shape(pred, model_name, symbol, version)
    except Exception as e:
        return {"symbol": symbol, "error": f"{type(e).__name__}: {e}"}


def state_space_batch_predict(
    model_name: str,
    series_list: list[dict],
    horizon: int = 5,
    version: str = "v1",
    *,
    max_workers: int | None = None,
) -> list[dict]:
    """Batch predict via per-stock state-space loop with shared hyperparams.

    Args:
        model_name: 'KalmanFilter' or 'MarkovSwitching' (must match STATE_SPACE_OVERLAY_MODELS)
      series_list: [{"symbol": str, "prices": list[float]}]
      horizon: forecast horizon in trading days (default 5)
      version: hyperparams version to load from GCS

    Returns: list of dicts (success or error per symbol).
    """
    if model_name not in _MIN_CONTEXT:
        return [{"symbol": s.get("symbol", "?"),
                  "error": f"unknown state-space model: {model_name}"}
                 for s in series_list]

    # Load hyperparams once (LRU cached)
    try:
        hyperparams = _load_hyperparams(model_name, version)
    except Exception as e:
        logger.error(f"[StateSpaceUniversal] hyperparams load failed for {model_name}/{version}: {e}")
        return [{"symbol": s.get("symbol", "?"),
                  "error": f"hyperparams load failed: {e}"} for s in series_list]

    # Lazy import the per-stock implementations
    try:
        if model_name == "KalmanFilter":
            from .models import run_kalman_filter as _runner
        else:  # MarkovSwitching
            from .models import run_markov_switching as _runner
    except Exception as e:
        return [{"symbol": s.get("symbol", "?"),
                  "error": f"runner import failed: {e}"} for s in series_list]

    min_n = _MIN_CONTEXT[model_name]
    max_workers = _max_workers_for_model(model_name, len(series_list), override=max_workers)

    def _run_one(row: dict) -> dict:
        return _predict_one_state_space(
            row=row,
            model_name=model_name,
            horizon=horizon,
            version=version,
            min_n=min_n,
            hyperparams=hyperparams,
            runner=_runner,
        )

    if max_workers <= 1:
        results = [_run_one(s) for s in series_list]
    else:
        # executor.map preserves input order, which keeps downstream symbol
        # overlay attachment identical to the sequential loop.
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            results = list(executor.map(_run_one, series_list))

    n_ok = sum(1 for r in results if not r.get("error"))
    logger.info(
        f"[StateSpaceUniversal] {model_name}/{version}: "
        f"{n_ok}/{len(series_list)} succeeded max_workers={max_workers}"
    )
    return results


def _state_space_row_signature(row: dict) -> dict:
    keys = (
        "symbol",
        "model",
        "forecast_pct",
        "up_prob",
        "confidence",
        "direction",
        "model_version",
        "n_used",
        "degraded",
        "fallback_reason",
        "error",
    )
    return {key: row.get(key) for key in keys if key in row}


def build_state_space_parallel_parity_report(
    model_name: str,
    series_list: list[dict],
    horizon: int = 5,
    version: str = "v1",
    *,
    parallel_workers: int = 2,
) -> dict:
    """Compare serial and parallel output for the same state-space payload."""
    serial = state_space_batch_predict(
        model_name=model_name,
        series_list=series_list,
        horizon=horizon,
        version=version,
        max_workers=1,
    )
    parallel = state_space_batch_predict(
        model_name=model_name,
        series_list=series_list,
        horizon=horizon,
        version=version,
        max_workers=parallel_workers,
    )
    mismatches = []
    for idx, (serial_row, parallel_row) in enumerate(zip(serial, parallel)):
        serial_sig = _state_space_row_signature(serial_row)
        parallel_sig = _state_space_row_signature(parallel_row)
        if serial_sig != parallel_sig:
            mismatches.append({
                "index": idx,
                "symbol": serial_row.get("symbol") or parallel_row.get("symbol"),
                "serial": serial_sig,
                "parallel": parallel_sig,
            })
    if len(serial) != len(parallel):
        mismatches.append({
            "index": None,
            "symbol": None,
            "serial_count": len(serial),
            "parallel_count": len(parallel),
        })
    return {
        "schema_version": "state-space-parallel-parity-v1",
        "model_name": model_name,
        "version": version,
        "horizon": horizon,
        "parallel_workers": _max_workers_for_model(model_name, len(series_list), override=parallel_workers),
        "n_input": len(series_list),
        "n_serial_success": sum(1 for row in serial if not row.get("error")),
        "n_parallel_success": sum(1 for row in parallel if not row.get("error")),
        "n_mismatch": len(mismatches),
        "status": "pass" if not mismatches else "fail",
        "mismatches": mismatches[:20],
    }


def state_space_overlays_batch_predict(
    model_names: list[str],
    series_list: list[dict],
    horizon: int = 5,
    version_by_model: dict[str, str] | None = None,
) -> dict:
    """Run multiple state-space overlays in one Modal container.

    This keeps Kalman/Markov as risk/regime overlays, but avoids two separate
    Modal remote calls, imports, and cold-start paths for the same series batch.
    """
    overlays: dict[str, dict] = {}
    metrics: dict[str, dict] = {}
    versions = version_by_model or {}
    models = [name for name in model_names if name in _MIN_CONTEXT]

    for model_name in models:
        t0 = time.time()
        version = versions.get(model_name, "v1")
        results = state_space_batch_predict(
            model_name=model_name,
            series_list=series_list,
            horizon=horizon,
            version=version,
        )
        elapsed_s = round(time.time() - t0, 3)
        n_success = sum(1 for row in results if not row.get("error"))
        n_fallback = sum(1 for row in results if row.get("degraded") or row.get("fallback_reason"))
        n_error = sum(1 for row in results if row.get("error"))
        overlays[model_name] = {
            "results": results,
            "n_input": len(series_list),
            "n_success": n_success,
            "n_fallback": n_fallback,
            "n_error": n_error,
            "version": version,
        }
        metrics[model_name] = {
            "elapsed_s": elapsed_s,
            "n_input": len(series_list),
            "n_success": n_success,
            "n_fallback": n_fallback,
            "n_error": n_error,
            "fallback_reasons": {
                str(reason): sum(1 for row in results if row.get("fallback_reason") == reason)
                for reason in sorted({row.get("fallback_reason") for row in results if row.get("fallback_reason")})
            },
        }

    return {
        "overlays": overlays,
        "metrics": metrics,
        "models": models,
        "n_input": len(series_list),
    }


CURRENT_CONFIG = {
    "version": "v1",
    "models": ["KalmanFilter", "MarkovSwitching"],
    "min_context": _MIN_CONTEXT,
    "strategy": "per-stock state-space inference with shared hyperparams (Stage 6.2)",
    "note": "Hyperparams in GCS at per_stock_state_space/{folder}/hyperparams_v{N}.json",
}
