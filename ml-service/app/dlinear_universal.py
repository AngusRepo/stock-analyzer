"""
dlinear_universal.py — Universal channel-independent DLinear forecaster.

2026-04-19 ML_POOL Plan A Stage 0.2: replaces per-stock DLinear (models.py:
run_dlinear which re-fits numpy slope/intercept per call) with one universal
PyTorch model trained on pooled multi-stock data.

Reference: Zeng et al. "Are Transformers Effective for Time Series
Forecasting?" AAAI 2023. Channel-independent DLinear: same weights apply to
every channel (stock), forward pass treats each channel independently. Paper
shows this simple decomposition + linear projection beats PatchTST/FEDformer
on most LTSF benchmarks.

Architecture:
  Input: (B, seq_len)     raw close prices, B = batch (stocks)
  Decompose: moving_avg(kernel=25) → trend, residual → seasonal
  Trend:    nn.Linear(seq_len, pred_len) on trend component
  Seasonal: nn.Linear(seq_len, pred_len) on seasonal component
  Output: (B, pred_len)   summed forecast

Storage:
  gs://stockvision-models/universal/dlinear/v{N}.pt   weights + metadata
  gs://stockvision-models/universal/dlinear/metadata_v{N}.json   training info
"""
from __future__ import annotations
import io
import json
import logging
import time
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Defaults aligned with v2 pipeline (60d lookback, 5d horizon, kernel=25)
DEFAULT_SEQ_LEN = 60
DEFAULT_PRED_LEN = 5
DEFAULT_KERNEL = 25

GCS_BUCKET = "stockvision-models"
GCS_WEIGHTS_PREFIX = "universal/dlinear"


# ─────────────────────────────────────────────────────────────────────────────
# Model definition (lazy torch import — Modal containers without torch can
# still import this module for testing harness)
# ─────────────────────────────────────────────────────────────────────────────

def _build_model(seq_len: int = DEFAULT_SEQ_LEN, pred_len: int = DEFAULT_PRED_LEN,
                 kernel: int = DEFAULT_KERNEL):
    """Create channel-independent DLinear nn.Module. Lazy torch import."""
    import torch
    import torch.nn as nn

    class _MovingAvg(nn.Module):
        """Symmetric moving average via reflective padding + avg pool."""
        def __init__(self, kernel_size: int):
            super().__init__()
            self.kernel_size = kernel_size
            self.avg = nn.AvgPool1d(kernel_size=kernel_size, stride=1, padding=0)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            # x: (B, L). Pad symmetrically by (kernel-1)//2 on each side.
            pad = (self.kernel_size - 1) // 2
            front = x[:, 0:1].repeat(1, pad)
            back = x[:, -1:].repeat(1, pad)
            x_padded = torch.cat([front, x, back], dim=1)  # (B, L+2*pad)
            return self.avg(x_padded.unsqueeze(1)).squeeze(1)  # (B, L)

    class DLinearCI(nn.Module):
        """Channel-independent DLinear (one set of weights, all channels share)."""
        def __init__(self, seq_len: int, pred_len: int, kernel: int):
            super().__init__()
            self.seq_len = seq_len
            self.pred_len = pred_len
            self.kernel = kernel
            self.decomp = _MovingAvg(kernel)
            self.linear_trend = nn.Linear(seq_len, pred_len, bias=True)
            self.linear_seasonal = nn.Linear(seq_len, pred_len, bias=True)
            # Init: linear_trend ≈ identity-like extrapolation; linear_seasonal small
            with torch.no_grad():
                # Mild trend continuation: weight last input → all outputs
                w_t = torch.zeros(pred_len, seq_len)
                w_t[:, -1] = 1.0
                self.linear_trend.weight.copy_(w_t)
                self.linear_trend.bias.zero_()
                self.linear_seasonal.weight.zero_()
                self.linear_seasonal.bias.zero_()

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            # x: (B, seq_len) raw close prices (or normalized — see _normalize)
            trend = self.decomp(x)        # (B, seq_len)
            seasonal = x - trend          # (B, seq_len)
            out_t = self.linear_trend(trend)        # (B, pred_len)
            out_s = self.linear_seasonal(seasonal)  # (B, pred_len)
            return out_t + out_s

    return DLinearCI(seq_len, pred_len, kernel)


# ─────────────────────────────────────────────────────────────────────────────
# Normalization (per-series scale invariance)
# ─────────────────────────────────────────────────────────────────────────────
# DLinear paper uses RevIN (reversible instance normalization) for cross-
# series scale variability. Without it, a stock priced $1000 dominates loss
# vs $20 stock. Implementation: subtract per-series mean, divide by std,
# forward, then de-normalize for output.
#
# 2026-04-19 D fix: epsilon 1e-9 → 1e-4 to match PatchTST. Near-constant
# series (delisted floors, stuck price) had std ≈ 0, dividing by 1e-9 blew
# normalized values into 1e6+ range → MSE loss 9.19e14 noise. Bumped epsilon
# treats those rows as ~zero variance (predict mean) without exploding loss.
# Direction accuracy uses denormalized comparison so unaffected by eps.

_NORM_EPS = 1e-4


def _normalize(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-row standardize. x: (B, L) → (x_norm, mean, std)."""
    mean = x.mean(axis=1, keepdims=True)
    std = x.std(axis=1, keepdims=True) + _NORM_EPS
    return (x - mean) / std, mean, std


def _denormalize(x_norm: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    return x_norm * std + mean


# ─────────────────────────────────────────────────────────────────────────────
# Training (one-shot, called from Modal function)
# ─────────────────────────────────────────────────────────────────────────────

def train_dlinear(
    series_close: list[list[float]],
    seq_len: int = DEFAULT_SEQ_LEN,
    pred_len: int = DEFAULT_PRED_LEN,
    kernel: int = DEFAULT_KERNEL,
    n_epochs: int = 30,
    batch_size: int = 256,
    lr: float = 1e-3,
    val_ratio: float = 0.15,
    device: str = "cpu",
) -> dict:
    """Train universal DLinear on pooled (stock, window) samples.

    Args:
      series_close: list of close-price arrays (one per stock).
        Each array length must be ≥ seq_len + pred_len.
      seq_len/pred_len/kernel: model dims
      n_epochs/batch_size/lr: training schedule
      val_ratio: fraction of windows held out for IC eval
      device: "cpu" or "cuda"

    Returns:
      {"state_dict": ..., "metadata": {...}}  for save_to_gcs
    """
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset

    t0 = time.time()
    dev = torch.device(device)

    # ── 1. Build (X, y) windows: every contiguous (seq_len + pred_len) span ──
    Xs, ys = [], []
    for prices in series_close:
        arr = np.asarray(prices, dtype=np.float32)
        if len(arr) < seq_len + pred_len:
            continue
        # Sliding windows with stride=1
        n_win = len(arr) - seq_len - pred_len + 1
        for i in range(n_win):
            Xs.append(arr[i:i + seq_len])
            ys.append(arr[i + seq_len:i + seq_len + pred_len])
    if not Xs:
        return {"error": "no valid windows from input series"}

    X = np.stack(Xs)  # (N, seq_len)
    y = np.stack(ys)  # (N, pred_len)
    n_total = len(X)
    logger.info(f"[DLinearUniversal] Built {n_total} windows from {len(series_close)} series")

    # Per-window normalize (RevIN-style)
    X_norm, mean_x, std_x = _normalize(X)
    y_norm = (y - mean_x) / std_x  # use same scale as X

    # ── 2. Train/val split (by window index, time-respecting via stable order) ──
    n_val = max(1, int(n_total * val_ratio))
    perm = np.arange(n_total)  # already time-ordered per stock (sliding); shuffle batches inside DataLoader
    train_idx, val_idx = perm[:-n_val], perm[-n_val:]
    Xt, yt = torch.tensor(X_norm[train_idx]), torch.tensor(y_norm[train_idx])
    Xv, yv = torch.tensor(X_norm[val_idx]), torch.tensor(y_norm[val_idx])

    train_ds = TensorDataset(Xt, yt)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)

    # ── 3. Model + optimizer ────────────────────────────────────────────────
    model = _build_model(seq_len, pred_len, kernel).to(dev)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    crit = nn.MSELoss()

    # ── 4. Train loop ──────────────────────────────────────────────────────
    best_val_loss = float("inf")
    best_state = None
    history = []
    for epoch in range(n_epochs):
        model.train()
        train_loss_sum, train_cnt = 0.0, 0
        for xb, yb in train_loader:
            xb, yb = xb.to(dev), yb.to(dev)
            opt.zero_grad()
            pred = model(xb)
            loss = crit(pred, yb)
            loss.backward()
            opt.step()
            train_loss_sum += loss.item() * len(xb)
            train_cnt += len(xb)
        train_loss = train_loss_sum / max(train_cnt, 1)

        # Val
        model.eval()
        with torch.no_grad():
            v_pred = model(Xv.to(dev))
            v_loss = crit(v_pred, yv.to(dev)).item()
        history.append({"epoch": epoch + 1, "train_loss": round(train_loss, 6), "val_loss": round(v_loss, 6)})
        if v_loss < best_val_loss:
            best_val_loss = v_loss
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    if best_state is None:
        best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    # ── 5. Direction accuracy on val (5d ahead) ──────────────────────────────
    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        v_pred_np = model(Xv.to(dev)).cpu().numpy()  # (N, pred_len) normalized
    # De-normalize
    mean_val = mean_x[val_idx]
    std_val = std_x[val_idx]
    v_pred_denorm = v_pred_np * std_val + mean_val
    actual_5d = y[val_idx][:, -1]
    pred_5d = v_pred_denorm[:, -1]
    last_input = X[val_idx][:, -1]
    actual_dir = actual_5d > last_input
    pred_dir = pred_5d > last_input
    dir_acc = float((actual_dir == pred_dir).mean())

    elapsed = round(time.time() - t0, 1)
    logger.info(f"[DLinearUniversal] Train done in {elapsed}s, best_val_loss={best_val_loss:.6f}, dir_acc={dir_acc:.3f}")

    return {
        "state_dict": {k: v.numpy().tolist() for k, v in best_state.items()},  # JSON-friendly for sanity, will save as torch
        "_state_dict_torch": best_state,  # for direct save
        "metadata": {
            "version": "v1",
            "seq_len": seq_len,
            "pred_len": pred_len,
            "kernel": kernel,
            "n_train_windows": int(len(train_idx)),
            "n_val_windows": int(len(val_idx)),
            "n_input_series": len(series_close),
            "best_val_loss": round(best_val_loss, 6),
            "val_dir_accuracy": round(dir_acc, 3),
            "n_epochs": n_epochs,
            "batch_size": batch_size,
            "lr": lr,
            "elapsed_s": elapsed,
            "history": history,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Save / Load (GCS)
# ─────────────────────────────────────────────────────────────────────────────

def save_to_gcs(state_dict, metadata: dict, version: str = "v1") -> dict:
    """Save trained DLinear state_dict + metadata to GCS."""
    import torch
    from google.cloud import storage

    bucket = storage.Client().bucket(GCS_BUCKET)

    buf = io.BytesIO()
    torch.save(state_dict, buf)
    buf.seek(0)
    weights_path = f"{GCS_WEIGHTS_PREFIX}/{version}.pt"
    bucket.blob(weights_path).upload_from_file(buf, content_type="application/octet-stream")

    meta_path = f"{GCS_WEIGHTS_PREFIX}/metadata_{version}.json"
    bucket.blob(meta_path).upload_from_string(
        json.dumps(metadata, indent=2), content_type="application/json"
    )
    logger.info(f"[DLinearUniversal] Saved {weights_path} + {meta_path}")
    return {"weights_path": weights_path, "metadata_path": meta_path}


def load_from_gcs(version: str = "v1"):
    """Load DLinear model + metadata from GCS. Returns (model, metadata) or (None, None)."""
    import torch
    from google.cloud import storage

    try:
        bucket = storage.Client().bucket(GCS_BUCKET)
        weights_blob = bucket.blob(f"{GCS_WEIGHTS_PREFIX}/{version}.pt")
        meta_blob = bucket.blob(f"{GCS_WEIGHTS_PREFIX}/metadata_{version}.json")
        if not weights_blob.exists():
            return None, None
        meta = json.loads(meta_blob.download_as_text()) if meta_blob.exists() else {}
        seq_len = meta.get("seq_len", DEFAULT_SEQ_LEN)
        pred_len = meta.get("pred_len", DEFAULT_PRED_LEN)
        kernel = meta.get("kernel", DEFAULT_KERNEL)
        model = _build_model(seq_len, pred_len, kernel)
        buf = io.BytesIO(weights_blob.download_as_bytes())
        state = torch.load(buf, map_location="cpu", weights_only=True)
        model.load_state_dict(state)
        model.eval()
        return model, meta
    except Exception as e:
        logger.warning(f"[DLinearUniversal] Load failed: {e}")
        return None, None


# ─────────────────────────────────────────────────────────────────────────────
# Inference (batch, called by Modal predict function)
# ─────────────────────────────────────────────────────────────────────────────

# Module-level model cache
_MODEL_CACHE: dict = {"model": None, "meta": None, "version": None}


def _get_model(version: str = "v1"):
    """Lazy load: cache model in module memory."""
    if _MODEL_CACHE["model"] is not None and _MODEL_CACHE["version"] == version:
        return _MODEL_CACHE["model"], _MODEL_CACHE["meta"]
    model, meta = load_from_gcs(version)
    _MODEL_CACHE["model"] = model
    _MODEL_CACHE["meta"] = meta
    _MODEL_CACHE["version"] = version
    return model, meta


def dlinear_batch_predict(
    series_list: list[dict], horizon_used: int = DEFAULT_PRED_LEN, version: str = "v1"
) -> list[dict]:
    """Batch predict via universal DLinear.

    Args:
      series_list: [{"symbol": str, "prices": list[float]}]
      horizon_used: which pred_len step to report as forecast (default last)
      version: GCS model version to load

    Returns:
      Same length as series_list. Each item:
        success: {"symbol", "model", "forecast_pct", "forecast_price",
                  "direction", "confidence", "n_used"}
        error:   {"symbol", "error"}
    """
    import torch

    model, meta = _get_model(version)
    if model is None:
        # No trained model yet — return error rows (caller handles)
        return [
            {"symbol": s.get("symbol", "?"), "error": f"DLinear weights not in GCS at {GCS_WEIGHTS_PREFIX}/{version}.pt"}
            for s in series_list
        ]

    seq_len = meta.get("seq_len", DEFAULT_SEQ_LEN)
    pred_len = meta.get("pred_len", DEFAULT_PRED_LEN)

    # Build batch tensor: take last seq_len from each series
    rows: list[np.ndarray] = []
    valid_idx: list[int] = []
    out_results: list[Optional[dict]] = []
    for i, s in enumerate(series_list):
        prices = s.get("prices") or []
        if len(prices) < seq_len:
            out_results.append({"symbol": s.get("symbol", "?"), "error": f"insufficient data ({len(prices)} < {seq_len})"})
            continue
        rows.append(np.asarray(prices[-seq_len:], dtype=np.float32))
        valid_idx.append(i)
        out_results.append(None)  # placeholder

    if not rows:
        return out_results

    X_batch = np.stack(rows)  # (B, seq_len)
    X_norm, mean_x, std_x = _normalize(X_batch)
    with torch.no_grad():
        pred_norm = model(torch.tensor(X_norm)).numpy()  # (B, pred_len)
    pred_denorm = pred_norm * std_x + mean_x  # (B, pred_len)

    # Use the last horizon step as forecast (5d ahead by default)
    h_idx = min(horizon_used, pred_len) - 1
    for batch_i, orig_i in enumerate(valid_idx):
        s = series_list[orig_i]
        last_price = float(X_batch[batch_i, -1])
        forecast_price = float(pred_denorm[batch_i, h_idx])
        forecast_pct = (forecast_price - last_price) / max(last_price, 1e-9)

        # Direction confidence from spread of predicted path vs std
        path_std = float(pred_denorm[batch_i].std())
        direction = "up" if forecast_pct > 0 else "down"
        confidence = min(0.85, max(0.35, 0.5 + min(0.35, abs(forecast_pct) * 8)))

        out_results[orig_i] = {
            "symbol": s.get("symbol", "?"),
            "model": "DLinear",
            "forecast_pct": round(forecast_pct, 4),
            "forecast_price": round(forecast_price, 4),
            "direction": direction,
            "confidence": round(confidence, 3),
            "n_used": int(seq_len),
            "model_version": version,
        }

    return out_results


# 2026-04-19 ML_POOL Stage 0.2 version config
CURRENT_CONFIG = {
    "version": "v1",
    "seq_len": DEFAULT_SEQ_LEN,
    "pred_len": DEFAULT_PRED_LEN,
    "kernel": DEFAULT_KERNEL,
    "strategy": "channel-independent learnable DLinear, RevIN-style per-window normalize, MSE loss",
}
