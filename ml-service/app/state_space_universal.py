"""
state_space_universal.py — Batch wrapper for per-stock state-space models.

2026-04-20 ML_POOL Stage 6.2: brings KalmanFilter + MarkovSwitching into
the v2 universal pipeline so:
  - Per-stock predictions land in D1 with model_name='KalmanFilter' / 'MarkovSwitching'
  - Stage 2 weekly IC tracker auto-picks them up via MANAGED_MODELS list
  - Stage 4 promote_check applies lifecycle to them
  - Ensemble V2 routes them through R1+R3 weight (hyperparam version is the
    "version" tracked in model_pool.json; same gcs_path = JSON file)

Architecture constraint: state-space models can't do tensor-batch inference
(each stock has its own latent state). The batch wrapper here is a Python
loop that calls the existing models.py:run_kalman_filter / run_markov_switching
once per stock, BUT:
  - Hyperparameters loaded ONCE from GCS shared file (not per-call)
  - Loop runs sequentially (state-space inference is fast: ~10-50ms per stock)

Output schema (matches Chronos/DLinear/PatchTST batch predictors):
  [{"symbol", "model", "forecast_pct", "up_prob", "confidence", "direction",
    "model_version"}]
  or {"symbol", "error"} on failure.
"""
from __future__ import annotations
import logging
from functools import lru_cache
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Min context for state-space (Kalman handles short series gracefully but
# Markov-Switching needs ~30+ obs to estimate regime params).
_MIN_CONTEXT = {
    "KalmanFilter":    10,
    "MarkovSwitching": 30,
}


@lru_cache(maxsize=4)
def _load_hyperparams(model_name: str, version: str) -> dict:
    """Module-cached hyperparam load (one shot per container lifetime per version).

    Falls back to model_pool.DEFAULT_STATE_SPACE_HYPERPARAMS if GCS read fails.
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
    }


def state_space_batch_predict(
    model_name: str,
    series_list: list[dict],
    horizon: int = 5,
    version: str = "v1",
) -> list[dict]:
    """Batch predict via per-stock state-space loop with shared hyperparams.

    Args:
      model_name: 'KalmanFilter' or 'MarkovSwitching' (must match MANAGED_MODELS)
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
    results: list[dict] = []
    for s in series_list:
        symbol = s.get("symbol", "?")
        prices = s.get("prices") or []
        if len(prices) < min_n:
            results.append({"symbol": symbol,
                             "error": f"insufficient data ({len(prices)} < {min_n})"})
            continue
        try:
            arr = np.asarray(prices, dtype=np.float64)
            try:
                pred = _runner(arr, horizon=horizon, stock_id=0, hyperparams=hyperparams)
            except TypeError:
                # Compatibility fallback for older deployed runners.
                pred = _runner(arr, horizon=horizon, stock_id=0)
            results.append(_to_dict_shape(pred, model_name, symbol, version))
        except Exception as e:
            results.append({"symbol": symbol, "error": f"{type(e).__name__}: {e}"})

    n_ok = sum(1 for r in results if not r.get("error"))
    logger.info(f"[StateSpaceUniversal] {model_name}/{version}: {n_ok}/{len(series_list)} succeeded")
    return results


CURRENT_CONFIG = {
    "version": "v1",
    "models": ["KalmanFilter", "MarkovSwitching"],
    "min_context": _MIN_CONTEXT,
    "strategy": "per-stock state-space inference with shared hyperparams (Stage 6.2)",
    "note": "Hyperparams in GCS at per_stock_state_space/{folder}/hyperparams_v{N}.json",
}
