"""Artifact-backed iTransformer batch serving for L3 sequence family."""

from __future__ import annotations

import io
import json
import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_SEQ_LEN = 60
DEFAULT_PRED_LEN = 5
DEFAULT_D_MODEL = 64
DEFAULT_N_HEADS = 4
DEFAULT_N_LAYERS = 2
DEFAULT_DROPOUT = 0.1
GCS_WEIGHTS_PREFIX = "universal/itransformer"
_NORM_EPS = 1e-4


def _get_bucket():
    from .model_store import _get_bucket as _shared_get_bucket

    bucket = _shared_get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    return bucket


def _build_model(
    seq_len: int = DEFAULT_SEQ_LEN,
    pred_len: int = DEFAULT_PRED_LEN,
    *,
    d_model: int = DEFAULT_D_MODEL,
    n_heads: int = DEFAULT_N_HEADS,
    n_layers: int = DEFAULT_N_LAYERS,
    dropout: float = DEFAULT_DROPOUT,
):
    import torch.nn as nn

    class ITransformerUniversal(nn.Module):
        def __init__(self):
            super().__init__()
            self.seq_len = seq_len
            self.pred_len = pred_len
            self.value_embedding = nn.Linear(seq_len, d_model)
            layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=n_heads,
                dim_feedforward=d_model * 4,
                dropout=dropout,
                batch_first=True,
                activation="gelu",
            )
            self.encoder = nn.TransformerEncoder(layer, num_layers=n_layers)
            self.projection = nn.Linear(d_model, pred_len)

        def forward(self, x):
            token = self.value_embedding(x.unsqueeze(1))
            encoded = self.encoder(token)
            return self.projection(encoded.squeeze(1))

    return ITransformerUniversal()


def _normalize(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = x.mean(axis=1, keepdims=True)
    std = x.std(axis=1, keepdims=True) + _NORM_EPS
    return (x - mean) / std, mean, std


def load_from_gcs(version: str = "v1"):
    import torch

    try:
        bucket = _get_bucket()
        weights_blob = bucket.blob(f"{GCS_WEIGHTS_PREFIX}/{version}.pt")
        meta_blob = bucket.blob(f"{GCS_WEIGHTS_PREFIX}/metadata_{version}.json")
        if not weights_blob.exists():
            return None, None
        meta = json.loads(meta_blob.download_as_text()) if meta_blob.exists() else {}
        model = _build_model(
            seq_len=int(meta.get("seq_len") or DEFAULT_SEQ_LEN),
            pred_len=int(meta.get("pred_len") or DEFAULT_PRED_LEN),
            d_model=int(meta.get("d_model") or DEFAULT_D_MODEL),
            n_heads=int(meta.get("n_heads") or DEFAULT_N_HEADS),
            n_layers=int(meta.get("n_layers") or DEFAULT_N_LAYERS),
            dropout=float(meta.get("dropout") or DEFAULT_DROPOUT),
        )
        buf = io.BytesIO(weights_blob.download_as_bytes())
        state = torch.load(buf, map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state and isinstance(state["state_dict"], dict):
            state = state["state_dict"]
        model.load_state_dict(state)
        model.eval()
        return model, meta
    except Exception as exc:  # noqa: BLE001
        logger.warning("[iTransformerUniversal] load failed: %s", exc)
        return None, None


_MODEL_CACHE: dict[str, Any] = {"model": None, "meta": None, "version": None}


def _get_model(version: str = "v1"):
    if _MODEL_CACHE["model"] is not None and _MODEL_CACHE["version"] == version:
        return _MODEL_CACHE["model"], _MODEL_CACHE["meta"]
    model, meta = load_from_gcs(version)
    _MODEL_CACHE["model"] = model
    _MODEL_CACHE["meta"] = meta
    _MODEL_CACHE["version"] = version
    return model, meta


def itransformer_batch_predict(
    series_list: list[dict], horizon_used: int = DEFAULT_PRED_LEN, version: str = "v1"
) -> list[dict]:
    import torch

    model, meta = _get_model(version)
    if model is None:
        return [
            {
                "symbol": row.get("symbol", "?"),
                "error": f"iTransformer weights not in GCS at {GCS_WEIGHTS_PREFIX}/{version}.pt",
            }
            for row in series_list
        ]

    seq_len = int((meta or {}).get("seq_len") or DEFAULT_SEQ_LEN)
    pred_len = int((meta or {}).get("pred_len") or DEFAULT_PRED_LEN)
    rows: list[np.ndarray] = []
    valid_idx: list[int] = []
    out: list[dict | None] = []
    for idx, row in enumerate(series_list):
        prices = row.get("prices") or []
        if len(prices) < seq_len:
            out.append({"symbol": row.get("symbol", "?"), "error": f"insufficient data ({len(prices)} < {seq_len})"})
            continue
        rows.append(np.asarray(prices[-seq_len:], dtype=np.float32))
        valid_idx.append(idx)
        out.append(None)

    if not rows:
        return [row for row in out if row is not None]

    x_batch = np.stack(rows)
    x_norm, mean_x, std_x = _normalize(x_batch)
    with torch.no_grad():
        pred_norm = model(torch.tensor(x_norm, dtype=torch.float32)).detach().cpu().numpy()
    pred_denorm = pred_norm * std_x + mean_x
    h_idx = min(int(horizon_used), pred_len) - 1

    for batch_idx, orig_idx in enumerate(valid_idx):
        row = series_list[orig_idx]
        last_price = float(x_batch[batch_idx, -1])
        forecast_price = float(pred_denorm[batch_idx, h_idx])
        forecast_pct = (forecast_price - last_price) / max(last_price, 1e-9)
        out[orig_idx] = {
            "symbol": row.get("symbol", "?"),
            "model": "iTransformer",
            "forecast_pct": round(forecast_pct, 4),
            "forecast_price": round(forecast_price, 4),
            "direction": "up" if forecast_pct > 0 else "down",
            "confidence": round(min(0.85, max(0.35, 0.5 + min(0.35, abs(forecast_pct) * 8))), 3),
            "n_used": int(seq_len),
            "model_version": version,
        }
    return [row if row is not None else {"symbol": series_list[idx].get("symbol", "?"), "error": "prediction missing"} for idx, row in enumerate(out)]
