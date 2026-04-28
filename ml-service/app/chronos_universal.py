"""
chronos_universal.py — Universal batch predictor for Amazon Chronos foundation model.

2026-04-19 ML_POOL Plan A Stage 0.1: moves Chronos from per-stock per-call
(models.py:run_chronos) into the v2 universal pipeline.

Key differences from per-call version:
- Module-level pipeline singleton (@lru_cache) — loaded once per container
  lifetime, not per prediction. Saves ~2-5s per call of ChronosPipeline
  .from_pretrained overhead.
- Batch interface: chronos_batch_predict(list of {symbol, prices}) returns
  list of forecasts. Caller (daily_pipeline_v2.node_ml_predict) invokes
  once for the entire watchlist instead of 33 per-stock calls.
- Zero GCS artifact — foundation model is zero-shot. Only a
gs://{GCS_BUCKET_NAME}/universal/chronos/v{N}_config.json is stored
  as version marker for ML_POOL lifecycle tracking (Stage 1+).

Caller contract:
    result = chronos_batch_predict(
        [{"symbol": "2330", "prices": [float, ...]}, ...],
        horizon=5,
    )
    # result = [
    #   {"symbol": "2330", "model": "Chronos", "forecast_pct": 0.012,
    #    "up_prob": 0.65, "confidence": 0.58, "direction": "up"},
    #   ...
    # ]
    # Error items: {"symbol": "...", "error": "insufficient data"}
"""
from functools import lru_cache
from typing import Iterable
import logging

import numpy as np

logger = logging.getLogger(__name__)

# Default model — chronos-t5-tiny: 8M params, CPU-friendly
# Swap to chronos-t5-mini (20M) or chronos-t5-small (46M) if accuracy needs
#
# Production guardrail:
# StockVision 目前部署中的 Chronos 路徑是 amazon/chronos-t5-tiny。
# 它是 CPU-friendly 的 zero-shot baseline，不是更大的 Chronos 變體；
# 任何升級到 mini/small/其他 checkpoint 的動作，都應視為新的架構/
# 成本決策，而不是默認優化。
_DEFAULT_MODEL_ID = "amazon/chronos-t5-tiny"

# Min samples required before we attempt forecasting (short series → noise)
_MIN_CONTEXT = 10

# Context truncation — Chronos T5 max is ~512 in training
_MAX_CONTEXT = 512


@lru_cache(maxsize=1)
def _get_pipeline(model_id: str = _DEFAULT_MODEL_ID):
    """Lazy singleton: load once per container lifetime."""
    import torch
    from chronos import ChronosPipeline

    logger.info(f"[ChronosUniversal] Loading pipeline: {model_id}")
    pipeline = ChronosPipeline.from_pretrained(
        model_id,
        device_map="cpu",
        torch_dtype=torch.float32,
    )
    logger.info(f"[ChronosUniversal] Pipeline ready")
    return pipeline


def _one_forecast(
    pipeline, prices: list[float], horizon: int, num_samples: int
) -> dict:
    """Produce a single series forecast. Raises on error (caller handles)."""
    import torch

    ctx_vals = prices[-min(_MAX_CONTEXT, len(prices)):]
    context = torch.tensor(ctx_vals, dtype=torch.float32).unsqueeze(0)

    with torch.no_grad():
        forecast_tensor = pipeline.predict(
            context=context,
            prediction_length=horizon,
            num_samples=num_samples,
        )
    # forecast_tensor shape: (1, num_samples, horizon)
    samples = forecast_tensor[0].numpy()  # (num_samples, horizon)

    last_price = float(prices[-1])
    # Use last horizon step for 5d forecast
    idx = horizon - 1
    forecast_median = float(np.median(samples[:, idx]))
    forecast_pct = (forecast_median - last_price) / max(last_price, 1e-9)

    up_count = int(np.sum(samples[:, idx] > last_price))
    up_prob = up_count / samples.shape[0]

    # Confidence from sample spread vs price vol
    spread = float(np.std(samples[:, idx]))
    confidence = min(
        0.85,
        max(0.35, max(up_prob, 1 - up_prob) * (1 - spread / (last_price * 0.05 + 1e-8) * 0.1)),
    )

    return {
        "model": "Chronos",
        "forecast_pct": round(forecast_pct, 4),
        "forecast_price": round(forecast_median, 4),
        "up_prob": round(up_prob, 3),
        "confidence": round(confidence, 3),
        "direction": "up" if up_prob > 0.5 else "down",
        "n_samples": num_samples,
    }


def chronos_batch_predict(
    series_list: list[dict],
    horizon: int = 5,
    num_samples: int = 20,
    model_id: str = _DEFAULT_MODEL_ID,
) -> list[dict]:
    """Batch forecast entry point.

    Args:
      series_list: [{"symbol": str, "prices": list[float]}] — one per stock.
      horizon: forecast length (default 5 trading days)
      num_samples: Chronos sampling count for uncertainty (default 20)
      model_id: override foundation model (default chronos-t5-tiny)

    Returns:
      Same length as series_list. Each item either
        {"symbol", "model", "forecast_pct", "up_prob", ...} on success
        {"symbol", "error": <reason>} on failure

    Implementation note:
      Chronos pipeline.predict() accepts batched tensors (N, context_len)
      but requires same context length. Here we invoke per-series to avoid
      padding artifacts from mixed context lengths. Performance is
      acceptable because the pipeline is module-cached (no reload cost)
      and chronos-t5-tiny inference is ~0.2-0.5s per series on CPU.
      Future optimization: tensor padding + single .predict() call if
      watchlist growth makes per-call overhead matter.

    Guardrail:
      Production default is chronos-t5-tiny on purpose. Do not silently
      promote this to larger Chronos checkpoints without explicit review.
    """
    # Fail-safe: missing chronos dependency → return error rows rather than crash
    try:
        pipeline = _get_pipeline(model_id)
    except ImportError as e:
        logger.warning(f"[ChronosUniversal] chronos package missing: {e}")
        return [{"symbol": s.get("symbol", "?"), "error": f"ImportError: {e}"} for s in series_list]
    except Exception as e:
        logger.error(f"[ChronosUniversal] Pipeline load failed: {e}")
        return [{"symbol": s.get("symbol", "?"), "error": f"PipelineLoadError: {e}"} for s in series_list]

    results: list[dict] = []
    for s in series_list:
        symbol = s.get("symbol", "?")
        prices = s.get("prices") or []
        if len(prices) < _MIN_CONTEXT:
            results.append({"symbol": symbol, "error": f"insufficient data ({len(prices)} < {_MIN_CONTEXT})"})
            continue
        try:
            out = _one_forecast(pipeline, prices, horizon=horizon, num_samples=num_samples)
            out["symbol"] = symbol
            results.append(out)
        except Exception as e:
            logger.warning(f"[ChronosUniversal] {symbol} forecast failed: {e}")
            results.append({"symbol": symbol, "error": f"{type(e).__name__}: {e}"})
    return results


# 2026-04-19 ML_POOL Stage 0.1: version config (for future lifecycle tracking)
CURRENT_CONFIG = {
    "version": "v1",
    "model_id": _DEFAULT_MODEL_ID,
    "production_baseline_note": "Current deployed Chronos path uses amazon/chronos-t5-tiny CPU zero-shot baseline; larger Chronos variants are not the accepted default.",
    "horizon_default": 5,
    "num_samples_default": 20,
    "min_context": _MIN_CONTEXT,
    "max_context": _MAX_CONTEXT,
    "strategy": "zero-shot foundation, no training",
}
