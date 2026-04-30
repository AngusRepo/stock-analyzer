"""
Universal batch predictor for the production Chronos slot.

StockVision treats Chronos as one alpha model slot, but that slot is now backed
by two production members:
- Chronos2ZeroShot: the public amazon/chronos-2 foundation model.
- Chronos2LoRA: optional fine-tuned adapter/checkpoint configured by env.

The downstream contract intentionally remains model="Chronos" so the ensemble
does not inflate the model denominator when the LoRA member is enabled.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

_DEFAULT_MODEL_ID = "amazon/chronos-2"
_LORA_MODEL_ID_ENV = "CHRONOS2_LORA_MODEL_ID"

_MIN_CONTEXT = 10
_MAX_CONTEXT = 8192
_QUANTILE_LEVELS = [0.1, 0.5, 0.9]


@lru_cache(maxsize=4)
def _get_pipeline(model_id: str = _DEFAULT_MODEL_ID):
    """Lazy singleton: load each Chronos-2 pipeline once per container."""
    import torch
    from chronos import Chronos2Pipeline

    logger.info("[ChronosUniversal] Loading Chronos-2 pipeline: %s", model_id)
    pipeline = Chronos2Pipeline.from_pretrained(
        model_id,
        device_map="cpu",
        torch_dtype=torch.float32,
    )
    logger.info("[ChronosUniversal] Pipeline ready: %s", model_id)
    return pipeline


def _context_df(symbol: str, prices: list[float]):
    """Build the pandas boundary required by Chronos2Pipeline.predict_df()."""
    import pandas as pd

    ctx_vals = [float(v) for v in prices[-min(_MAX_CONTEXT, len(prices)):]]
    timestamps = pd.date_range(
        end=pd.Timestamp.today().normalize(),
        periods=len(ctx_vals),
        freq="D",
    )
    return pd.DataFrame({
        "id": [symbol] * len(ctx_vals),
        "timestamp": timestamps,
        "target": ctx_vals,
    })


def _as_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if np.isfinite(out) else None


def _select_forecast_row(pred_df) -> dict[str, float]:
    """Extract the last-horizon quantiles from a Chronos-2 prediction frame."""
    if pred_df is None or len(pred_df) == 0:
        raise ValueError("empty Chronos-2 prediction frame")
    row = pred_df.sort_values("timestamp").iloc[-1].to_dict() if "timestamp" in pred_df else pred_df.iloc[-1].to_dict()
    q10 = _as_float(row.get("0.1", row.get(0.1)))
    q50 = _as_float(row.get("0.5", row.get(0.5)))
    q90 = _as_float(row.get("0.9", row.get(0.9)))
    if q50 is None:
        for key in ("mean", "median", "target", "prediction"):
            q50 = _as_float(row.get(key))
            if q50 is not None:
                break
    if q50 is None:
        numeric = [
            _as_float(value)
            for key, value in row.items()
            if key not in {"id", "item_id", "timestamp"}
        ]
        numeric = [value for value in numeric if value is not None]
        if not numeric:
            raise ValueError(f"Chronos-2 prediction frame has no numeric forecast columns: {list(row)}")
        q50 = numeric[-1]
    return {"q10": q10 if q10 is not None else q50, "q50": q50, "q90": q90 if q90 is not None else q50}


def _one_member_forecast(pipeline, symbol: str, prices: list[float], horizon: int) -> dict:
    context_df = _context_df(symbol, prices)
    pred_df = pipeline.predict_df(
        context_df,
        prediction_length=horizon,
        quantile_levels=_QUANTILE_LEVELS,
        id_column="id",
        timestamp_column="timestamp",
        target="target",
    )
    qs = _select_forecast_row(pred_df)
    last_price = float(prices[-1])
    forecast_price = qs["q50"]
    forecast_pct = (forecast_price - last_price) / max(last_price, 1e-9)
    if qs["q10"] > last_price:
        up_prob = 0.8
    elif qs["q90"] < last_price:
        up_prob = 0.2
    else:
        band = max(abs(qs["q90"] - qs["q10"]), last_price * 0.01, 1e-9)
        up_prob = 0.5 + max(-0.3, min(0.3, (forecast_price - last_price) / band))
    spread_ratio = abs(qs["q90"] - qs["q10"]) / max(last_price, 1e-9)
    confidence = min(0.85, max(0.35, max(up_prob, 1 - up_prob) * (1 - min(spread_ratio, 0.20))))
    return {
        "forecast_pct": float(forecast_pct),
        "forecast_price": float(forecast_price),
        "up_prob": float(up_prob),
        "confidence": float(confidence),
        "quantiles": qs,
    }


def _combine_members(members: list[dict]) -> dict:
    if not members:
        raise ValueError("no Chronos-2 member forecasts")
    forecast_pct = float(np.mean([m["forecast_pct"] for m in members]))
    forecast_price = float(np.mean([m["forecast_price"] for m in members]))
    up_prob = float(np.mean([m["up_prob"] for m in members]))
    confidence = float(np.mean([m["confidence"] for m in members]))
    return {
        "model": "Chronos",
        "model_family": "Chronos2",
        "forecast_pct": round(forecast_pct, 4),
        "forecast_price": round(forecast_price, 4),
        "up_prob": round(up_prob, 3),
        "confidence": round(confidence, 3),
        "direction": "up" if up_prob > 0.5 else "down",
        "n_members": len(members),
    }


def _one_forecast(
    zero_shot_pipeline,
    symbol: str,
    prices: list[float],
    horizon: int,
    lora_model_id: str | None,
) -> dict:
    members = [_one_member_forecast(zero_shot_pipeline, symbol, prices, horizon)]
    member_names = ["Chronos2ZeroShot"]
    lora_status = "not_configured"
    if lora_model_id:
        lora_pipeline = _get_pipeline(lora_model_id)
        members.append(_one_member_forecast(lora_pipeline, symbol, prices, horizon))
        member_names.append("Chronos2LoRA")
        lora_status = "active"
    out = _combine_members(members)
    out["production_members"] = member_names
    out["lora_status"] = lora_status
    return out


def chronos_batch_predict(
    series_list: list[dict],
    horizon: int = 5,
    num_samples: int = 20,
    model_id: str = _DEFAULT_MODEL_ID,
) -> list[dict]:
    """Batch forecast entry point.

    `num_samples` is retained for backward-compatible payloads. Chronos-2 emits
    quantile forecasts through predict_df, so uncertainty comes from quantiles
    rather than Chronos T5 sample paths.
    """
    try:
        zero_shot_pipeline = _get_pipeline(model_id or _DEFAULT_MODEL_ID)
    except ImportError as e:
        logger.warning("[ChronosUniversal] chronos package missing: %s", e)
        return [{"symbol": s.get("symbol", "?"), "error": f"ImportError: {e}"} for s in series_list]
    except Exception as e:
        logger.error("[ChronosUniversal] Pipeline load failed: %s", e)
        return [{"symbol": s.get("symbol", "?"), "error": f"PipelineLoadError: {e}"} for s in series_list]

    lora_model_id = os.environ.get(_LORA_MODEL_ID_ENV, "").strip() or None
    results: list[dict] = []
    for s in series_list:
        symbol = s.get("symbol", "?")
        prices = s.get("prices") or []
        if len(prices) < _MIN_CONTEXT:
            results.append({"symbol": symbol, "error": f"insufficient data ({len(prices)} < {_MIN_CONTEXT})"})
            continue
        try:
            out = _one_forecast(
                zero_shot_pipeline,
                symbol=symbol,
                prices=prices,
                horizon=horizon,
                lora_model_id=lora_model_id,
            )
            out["symbol"] = symbol
            results.append(out)
        except Exception as e:
            logger.warning("[ChronosUniversal] %s forecast failed: %s", symbol, e)
            results.append({"symbol": symbol, "error": f"{type(e).__name__}: {e}"})
    return results


CURRENT_CONFIG = {
    "version": "v2",
    "model_id": _DEFAULT_MODEL_ID,
    "production_members": ["Chronos2ZeroShot", "Chronos2LoRA"],
    "production_baseline_note": "Production Chronos slot is Chronos-2 zero-shot plus optional LoRA fine-tuned member.",
    "lora_model_id_env": _LORA_MODEL_ID_ENV,
    "horizon_default": 5,
    "num_samples_default": 20,
    "min_context": _MIN_CONTEXT,
    "max_context": _MAX_CONTEXT,
    "strategy": "Chronos-2 production replacement, not challenger shadow",
}
