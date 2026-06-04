"""Config-backed TimesFM batch serving for L3 sequence family."""

from __future__ import annotations

import json
import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_SEQ_LEN = 256
DEFAULT_PRED_LEN = 5
DEFAULT_MODEL_ID = "google/timesfm-2.0-500m-pytorch"
GCS_CONFIG_PREFIX = "universal/timesfm"
_MODEL_CACHE: dict[str, Any] = {}
_CONFIG_CACHE: dict[str, dict | None] = {}


def _get_bucket():
    from .model_store import _get_bucket as _shared_get_bucket

    bucket = _shared_get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    return bucket


def load_config_from_gcs(version: str = "v1") -> dict | None:
    if version in _CONFIG_CACHE:
        return _CONFIG_CACHE[version]
    try:
        bucket = _get_bucket()
        config_blob = bucket.blob(f"{GCS_CONFIG_PREFIX}/{version}.json")
        meta_blob = bucket.blob(f"{GCS_CONFIG_PREFIX}/metadata_{version}.json")
        if config_blob.exists():
            config = json.loads(config_blob.download_as_text())
        elif meta_blob.exists():
            config = json.loads(meta_blob.download_as_text())
        else:
            _CONFIG_CACHE[version] = None
            return None
        if not isinstance(config, dict):
            _CONFIG_CACHE[version] = None
            return None
        _CONFIG_CACHE[version] = config
        return config
    except Exception as exc:  # noqa: BLE001
        logger.warning("[TimesFMUniversal] config load failed: %s", exc)
        _CONFIG_CACHE[version] = None
        return None


def _load_timesfm_model(config: dict):
    import timesfm

    model_id = str(config.get("model_id") or DEFAULT_MODEL_ID)
    max_context = int(config.get("max_context") or max(DEFAULT_SEQ_LEN, int(config.get("seq_len") or DEFAULT_SEQ_LEN)))
    max_horizon = int(config.get("max_horizon") or max(DEFAULT_PRED_LEN, int(config.get("pred_len") or DEFAULT_PRED_LEN)))
    cache_key = f"{model_id}:{max_context}:{max_horizon}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    if hasattr(timesfm, "TimesFM_2p5_200M_torch"):
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(model_id)
        model.compile(
            timesfm.ForecastConfig(
                max_context=max_context,
                max_horizon=max_horizon,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                infer_is_positive=True,
                fix_quantile_crossing=True,
            )
        )
        _MODEL_CACHE[cache_key] = model
        return model

    if hasattr(timesfm, "TimesFm"):
        model = timesfm.TimesFm(
            hparams=timesfm.TimesFmHparams(
                backend=str(config.get("backend") or "gpu"),
                per_core_batch_size=int(config.get("per_core_batch_size") or 32),
                horizon_len=max_horizon,
                num_layers=int(config.get("num_layers") or 50),
                use_positional_embedding=bool(config.get("use_positional_embedding", False)),
                context_len=min(max_context, 2048),
            ),
            checkpoint=timesfm.TimesFmCheckpoint(huggingface_repo_id=model_id),
        )
        _MODEL_CACHE[cache_key] = model
        return model

    raise RuntimeError("timesfm package exposes neither TimesFM_2p5_200M_torch nor TimesFm")


def _forecast(model, *, horizon: int, inputs: list[np.ndarray]):
    try:
        return model.forecast(horizon=horizon, inputs=inputs)
    except TypeError:
        return model.forecast(inputs, freq=[0] * len(inputs))


def timesfm_batch_predict(
    series_list: list[dict], horizon_used: int = DEFAULT_PRED_LEN, version: str = "v1"
) -> list[dict]:
    config = load_config_from_gcs(version)
    if not config:
        return [
            {"symbol": row.get("symbol", "?"), "error": f"TimesFM config not in GCS at {GCS_CONFIG_PREFIX}/{version}.json"}
            for row in series_list
        ]

    seq_len = int(config.get("seq_len") or DEFAULT_SEQ_LEN)
    pred_len = int(config.get("pred_len") or DEFAULT_PRED_LEN)
    horizon = max(pred_len, int(horizon_used))
    inputs: list[np.ndarray] = []
    valid_idx: list[int] = []
    out: list[dict | None] = []
    for idx, row in enumerate(series_list):
        prices = row.get("prices") or []
        if len(prices) < seq_len:
            out.append({"symbol": row.get("symbol", "?"), "error": f"insufficient data ({len(prices)} < {seq_len})"})
            continue
        inputs.append(np.asarray(prices[-seq_len:], dtype=np.float32))
        valid_idx.append(idx)
        out.append(None)

    if not inputs:
        return [row for row in out if row is not None]

    try:
        model = _load_timesfm_model(config)
        point_forecast, _quantiles = _forecast(model, horizon=horizon, inputs=inputs)
        point = np.asarray(point_forecast, dtype=float)
    except Exception as exc:  # noqa: BLE001
        return [
            {"symbol": row.get("symbol", "?"), "error": f"TimesFM inference failed: {type(exc).__name__}: {exc}"}
            for row in series_list
        ]

    h_idx = min(int(horizon_used), point.shape[1]) - 1
    for batch_idx, orig_idx in enumerate(valid_idx):
        row = series_list[orig_idx]
        last_price = float(inputs[batch_idx][-1])
        forecast_price = float(point[batch_idx, h_idx])
        forecast_pct = (forecast_price - last_price) / max(last_price, 1e-9)
        out[orig_idx] = {
            "symbol": row.get("symbol", "?"),
            "model": "TimesFM",
            "forecast_pct": round(forecast_pct, 4),
            "forecast_price": round(forecast_price, 4),
            "direction": "up" if forecast_pct > 0 else "down",
            "confidence": round(min(0.85, max(0.35, 0.5 + min(0.35, abs(forecast_pct) * 8))), 3),
            "n_used": int(seq_len),
            "model_version": version,
            "model_id": str(config.get("model_id") or DEFAULT_MODEL_ID),
        }
    return [row if row is not None else {"symbol": series_list[idx].get("symbol", "?"), "error": "prediction missing"} for idx, row in enumerate(out)]
