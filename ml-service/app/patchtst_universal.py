"""
patchtst_universal.py — Universal channel-independent PatchTST forecaster.

2026-04-19 ML_POOL Plan A Stage 0.3: replaces per-stock PatchTST
(models.py:run_patchtst) with one universal Transformer trained on pooled
multi-stock close series.

Reference: Nie et al. "A Time Series is Worth 64 Words: Long-term
Forecasting with Transformers" ICLR 2023. Channel-independent PatchTST:
- Patch the input series into non-overlapping patches (each becomes a token).
- Transformer encoder processes the patch sequence.
- Linear head maps flattened encoder output to forecast horizon.
- Same weights for every channel (stock).

Architecture:
  Input (B, seq_len)
  → RevIN normalize (per-window mean/std)
  → Reshape into patches: (B, n_patches, patch_len)
  → Patch embedding: nn.Linear(patch_len, d_model) → (B, n_patches, d_model)
  → + positional embedding
  → TransformerEncoder × n_layers
  → Flatten (B, n_patches * d_model)
  → nn.Linear(n_patches * d_model, pred_len)
  → Denormalize

Storage: gs://{GCS_BUCKET_NAME}/universal/patchtst/v{N}.pt
"""
from __future__ import annotations
import io
import json
import logging
import time

import numpy as np

logger = logging.getLogger(__name__)

# Paper-aligned defaults; same seq_len/pred_len as DLinear for v2 pipeline parity
DEFAULT_SEQ_LEN = 60
DEFAULT_PRED_LEN = 5
DEFAULT_PATCH_LEN = 12       # 60 / 12 = 5 patches (no remainder)
DEFAULT_STRIDE = 12          # non-overlapping patches
DEFAULT_D_MODEL = 128
DEFAULT_N_HEADS = 8
DEFAULT_N_LAYERS = 3
DEFAULT_DROPOUT = 0.1

GCS_WEIGHTS_PREFIX = "universal/patchtst"


def _get_bucket():
    from .model_store import _get_bucket as _shared_get_bucket

    bucket = _shared_get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    return bucket


def _build_model(
    seq_len: int = DEFAULT_SEQ_LEN,
    pred_len: int = DEFAULT_PRED_LEN,
    patch_len: int = DEFAULT_PATCH_LEN,
    stride: int = DEFAULT_STRIDE,
    d_model: int = DEFAULT_D_MODEL,
    n_heads: int = DEFAULT_N_HEADS,
    n_layers: int = DEFAULT_N_LAYERS,
    dropout: float = DEFAULT_DROPOUT,
):
    """Lazy torch import — build channel-independent PatchTST."""
    import torch
    import torch.nn as nn

    if (seq_len - patch_len) % stride != 0:
        raise ValueError(
            f"PatchTST: (seq_len - patch_len) must be divisible by stride; "
            f"got seq_len={seq_len}, patch_len={patch_len}, stride={stride}"
        )
    n_patches = (seq_len - patch_len) // stride + 1

    class PatchTSTUniversal(nn.Module):
        def __init__(self):
            super().__init__()
            self.seq_len = seq_len
            self.pred_len = pred_len
            self.patch_len = patch_len
            self.stride = stride
            self.n_patches = n_patches
            self.d_model = d_model
            # Patch embedding: each patch_len-vector → d_model token
            self.patch_embed = nn.Linear(patch_len, d_model, bias=True)
            # Learned positional embedding (n_patches, d_model)
            self.pos_embed = nn.Parameter(torch.zeros(1, n_patches, d_model))
            # Transformer encoder
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=n_heads,
                dim_feedforward=d_model * 4,
                dropout=dropout,
                batch_first=True,
                activation="gelu",
            )
            self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
            # Flatten + linear head
            self.head_dropout = nn.Dropout(dropout)
            self.head = nn.Linear(n_patches * d_model, pred_len, bias=True)
            # Init head with small magnitude (start near zero forecast)
            nn.init.trunc_normal_(self.pos_embed, std=0.02)
            nn.init.zeros_(self.head.bias)

        def _patchify(self, x: torch.Tensor) -> torch.Tensor:
            # x: (B, seq_len) → (B, n_patches, patch_len) via unfold
            # unfold(dim=-1, size=patch_len, step=stride)
            return x.unfold(dimension=-1, size=self.patch_len, step=self.stride)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            # x: (B, seq_len) raw (caller normalizes)
            patches = self._patchify(x)             # (B, n_patches, patch_len)
            tokens = self.patch_embed(patches)      # (B, n_patches, d_model)
            tokens = tokens + self.pos_embed        # (B, n_patches, d_model)
            enc = self.encoder(tokens)              # (B, n_patches, d_model)
            flat = enc.flatten(start_dim=1)         # (B, n_patches * d_model)
            flat = self.head_dropout(flat)
            return self.head(flat)                  # (B, pred_len)

    return PatchTSTUniversal()


# ─────────────────────────────────────────────────────────────────────────────
# Normalization (same as DLinear — per-window RevIN with safer epsilon)
# ─────────────────────────────────────────────────────────────────────────────
# Stage 0.2 found epsilon=1e-9 produces huge loss on near-constant series.
# Bump to 1e-4 (relative to typical TWD prices) — direction unaffected.

_NORM_EPS = 1e-4


def _normalize(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-row standardize. x: (B, L) → (x_norm, mean, std)."""
    mean = x.mean(axis=1, keepdims=True)
    std = x.std(axis=1, keepdims=True) + _NORM_EPS
    return (x - mean) / std, mean, std


# ─────────────────────────────────────────────────────────────────────────────
# Training
# ─────────────────────────────────────────────────────────────────────────────


def train_patchtst(
    series_close: list[list[float]],
    sequence_records: list[dict] | None = None,
    seq_len: int = DEFAULT_SEQ_LEN,
    pred_len: int = DEFAULT_PRED_LEN,
    patch_len: int = DEFAULT_PATCH_LEN,
    stride: int = DEFAULT_STRIDE,
    d_model: int = DEFAULT_D_MODEL,
    n_heads: int = DEFAULT_N_HEADS,
    n_layers: int = DEFAULT_N_LAYERS,
    dropout: float = DEFAULT_DROPOUT,
    n_epochs: int = 30,
    batch_size: int = 256,
    lr: float = 5e-4,
    weight_decay: float = 1e-5,
    val_ratio: float = 0.15,
    device: str = "cpu",
) -> dict:
    """Train universal PatchTST on pooled (stock, window) samples.

    Same data construction as DLinear (sliding windows of seq_len + pred_len)
    and RevIN-style per-window normalize.
    """
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset
    from .sequence_training import build_sequence_window_dataset, sequence_oos_ic_from_forecast

    t0 = time.time()
    dev = torch.device(device)

    # ── 1. Build (X, y) windows ──────────────────────────────────────────────
    sequence_dataset = None
    if sequence_records:
        sequence_dataset = build_sequence_window_dataset(
            sequence_records,
            seq_len=seq_len,
            pred_len=pred_len,
            oos_ratio=val_ratio,
        )
        if not sequence_dataset.report.get("lifecycle_ready"):
            return {"error": f"sequence_records not lifecycle-ready: {sequence_dataset.report}"}
        X = np.concatenate([sequence_dataset.X_train, sequence_dataset.X_oos], axis=0)
        y = np.concatenate([sequence_dataset.y_train, sequence_dataset.y_oos], axis=0)
        train_idx = np.arange(len(sequence_dataset.X_train))
        val_idx = np.arange(len(sequence_dataset.X_train), len(X))
        sequence_report = sequence_dataset.report
    else:
        Xs, ys = [], []
        for prices in series_close:
            arr = np.asarray(prices, dtype=np.float32)
            if len(arr) < seq_len + pred_len:
                continue
            n_win = len(arr) - seq_len - pred_len + 1
            for i in range(n_win):
                Xs.append(arr[i:i + seq_len])
                ys.append(arr[i + seq_len:i + seq_len + pred_len])
        if not Xs:
            return {"error": "no valid windows from input series"}

        X = np.stack(Xs)
        y = np.stack(ys)
        n_total = len(X)
        n_val = max(1, int(n_total * val_ratio))
        perm = np.arange(n_total)
        train_idx, val_idx = perm[:-n_val], perm[-n_val:]
        sequence_report = {
            "input_series": len(series_close),
            "windows": int(n_total),
            "lifecycle_ready": False,
            "reason": "legacy_series_close_without_symbol_date",
        }
    n_total = len(X)
    logger.info(f"[PatchTSTUniversal] Built {n_total} windows from {sequence_report.get('input_series')} series")

    X_norm, mean_x, std_x = _normalize(X)
    y_norm = (y - mean_x) / std_x

    Xt, yt = torch.tensor(X_norm[train_idx]), torch.tensor(y_norm[train_idx])
    Xv, yv = torch.tensor(X_norm[val_idx]), torch.tensor(y_norm[val_idx])

    train_ds = TensorDataset(Xt, yt)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)

    # ── 2. Model + optimizer ────────────────────────────────────────────────
    model = _build_model(
        seq_len=seq_len, pred_len=pred_len,
        patch_len=patch_len, stride=stride,
        d_model=d_model, n_heads=n_heads, n_layers=n_layers, dropout=dropout,
    ).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    crit = nn.MSELoss()

    # ── 3. Train loop with best-state snapshot ──────────────────────────────
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
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            opt.step()
            train_loss_sum += loss.item() * len(xb)
            train_cnt += len(xb)
        train_loss = train_loss_sum / max(train_cnt, 1)

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

    # ── 4. Direction accuracy on val (5d ahead) ──────────────────────────────
    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        v_pred_np = model(Xv.to(dev)).cpu().numpy()
    mean_val = mean_x[val_idx]
    std_val = std_x[val_idx]
    v_pred_denorm = v_pred_np * std_val + mean_val
    actual_5d = y[val_idx][:, -1]
    pred_5d = v_pred_denorm[:, -1]
    last_input = X[val_idx][:, -1]
    actual_dir = actual_5d > last_input
    pred_dir = pred_5d > last_input
    dir_acc = float((actual_dir == pred_dir).mean())
    if sequence_dataset is not None:
        ic_metrics = sequence_oos_ic_from_forecast(
            forecast_prices=pred_5d,
            dataset=sequence_dataset,
        )
    else:
        ic_metrics = {
            "oos_ic": 0.0,
            "oos_samples": int(len(val_idx)),
            "daily_ic_count": 0,
            "passed": False,
            "reason": "legacy_series_close_without_symbol_date",
        }

    elapsed = round(time.time() - t0, 1)
    logger.info(f"[PatchTSTUniversal] Train done in {elapsed}s, best_val_loss={best_val_loss:.6f}, dir_acc={dir_acc:.3f}")

    return {
        "_state_dict_torch": best_state,
        "metadata": {
            "version": "v1",
            "seq_len": seq_len,
            "pred_len": pred_len,
            "patch_len": patch_len,
            "stride": stride,
            "d_model": d_model,
            "n_heads": n_heads,
            "n_layers": n_layers,
            "dropout": dropout,
            "n_train_windows": int(len(train_idx)),
            "n_val_windows": int(len(val_idx)),
            "n_input_series": len(series_close),
            "best_val_loss": round(best_val_loss, 6),
            "val_dir_accuracy": round(dir_acc, 3),
            "n_epochs": n_epochs,
            "batch_size": batch_size,
            "lr": lr,
            "weight_decay": weight_decay,
            "elapsed_s": elapsed,
            "history": history,
            "norm_eps": _NORM_EPS,
            "sequence_report": sequence_report,
            "oos_ic": ic_metrics.get("oos_ic"),
            "oos_samples": ic_metrics.get("oos_samples"),
            "daily_ic_count": ic_metrics.get("daily_ic_count"),
        },
        "ic_tracking": {
            "PatchTST": {
                **ic_metrics,
                "source": "sequence_oos",
            },
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Save / Load (GCS)
# ─────────────────────────────────────────────────────────────────────────────


def save_to_gcs(state_dict, metadata: dict, version: str = "v1") -> dict:
    import torch
    bucket = _get_bucket()
    buf = io.BytesIO()
    torch.save(state_dict, buf)
    buf.seek(0)
    weights_path = f"{GCS_WEIGHTS_PREFIX}/{version}.pt"
    bucket.blob(weights_path).upload_from_file(buf, content_type="application/octet-stream")

    meta_path = f"{GCS_WEIGHTS_PREFIX}/metadata_{version}.json"
    bucket.blob(meta_path).upload_from_string(json.dumps(metadata, indent=2), content_type="application/json")
    logger.info(f"[PatchTSTUniversal] Saved {weights_path} + {meta_path}")
    return {"weights_path": weights_path, "metadata_path": meta_path}


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
            seq_len=meta.get("seq_len", DEFAULT_SEQ_LEN),
            pred_len=meta.get("pred_len", DEFAULT_PRED_LEN),
            patch_len=meta.get("patch_len", DEFAULT_PATCH_LEN),
            stride=meta.get("stride", DEFAULT_STRIDE),
            d_model=meta.get("d_model", DEFAULT_D_MODEL),
            n_heads=meta.get("n_heads", DEFAULT_N_HEADS),
            n_layers=meta.get("n_layers", DEFAULT_N_LAYERS),
            dropout=meta.get("dropout", DEFAULT_DROPOUT),
        )
        buf = io.BytesIO(weights_blob.download_as_bytes())
        state = torch.load(buf, map_location="cpu", weights_only=True)
        model.load_state_dict(state)
        model.eval()
        return model, meta
    except Exception as e:
        logger.warning(f"[PatchTSTUniversal] Load failed: {e}")
        return None, None


# ─────────────────────────────────────────────────────────────────────────────
# Inference (batch)
# ─────────────────────────────────────────────────────────────────────────────

_MODEL_CACHE: dict = {"model": None, "meta": None, "version": None}


def _get_model(version: str = "v1"):
    if _MODEL_CACHE["model"] is not None and _MODEL_CACHE["version"] == version:
        return _MODEL_CACHE["model"], _MODEL_CACHE["meta"]
    model, meta = load_from_gcs(version)
    _MODEL_CACHE["model"] = model
    _MODEL_CACHE["meta"] = meta
    _MODEL_CACHE["version"] = version
    return model, meta


def patchtst_batch_predict(
    series_list: list[dict], horizon_used: int = DEFAULT_PRED_LEN, version: str = "v1"
) -> list[dict]:
    """Batch predict via universal PatchTST.

    Args:
      series_list: [{"symbol": str, "prices": list[float]}]
      horizon_used: which pred_len step to report (default last)
      version: GCS model version

    Returns:
      Same length as series_list. Each item:
        success: {"symbol", "model", "forecast_pct", "forecast_price",
                  "direction", "confidence", "n_used", "model_version"}
        error:   {"symbol", "error"}
    """
    import torch

    model, meta = _get_model(version)
    if model is None:
        return [
            {"symbol": s.get("symbol", "?"), "error": f"PatchTST weights not in GCS at {GCS_WEIGHTS_PREFIX}/{version}.pt"}
            for s in series_list
        ]

    seq_len = meta.get("seq_len", DEFAULT_SEQ_LEN)
    pred_len = meta.get("pred_len", DEFAULT_PRED_LEN)

    rows: list[np.ndarray] = []
    valid_idx: list[int] = []
    out_results: list = []
    for i, s in enumerate(series_list):
        prices = s.get("prices") or []
        if len(prices) < seq_len:
            out_results.append({"symbol": s.get("symbol", "?"), "error": f"insufficient data ({len(prices)} < {seq_len})"})
            continue
        rows.append(np.asarray(prices[-seq_len:], dtype=np.float32))
        valid_idx.append(i)
        out_results.append(None)

    if not rows:
        return out_results

    X_batch = np.stack(rows)
    X_norm, mean_x, std_x = _normalize(X_batch)
    with torch.no_grad():
        pred_norm = model(torch.tensor(X_norm)).numpy()
    pred_denorm = pred_norm * std_x + mean_x

    h_idx = min(horizon_used, pred_len) - 1
    for batch_i, orig_i in enumerate(valid_idx):
        s = series_list[orig_i]
        last_price = float(X_batch[batch_i, -1])
        forecast_price = float(pred_denorm[batch_i, h_idx])
        forecast_pct = (forecast_price - last_price) / max(last_price, 1e-9)
        direction = "up" if forecast_pct > 0 else "down"
        confidence = min(0.85, max(0.35, 0.5 + min(0.35, abs(forecast_pct) * 8)))

        out_results[orig_i] = {
            "symbol": s.get("symbol", "?"),
            "model": "PatchTST",
            "forecast_pct": round(forecast_pct, 4),
            "forecast_price": round(forecast_price, 4),
            "direction": direction,
            "confidence": round(confidence, 3),
            "n_used": int(seq_len),
            "model_version": version,
        }

    return out_results


CURRENT_CONFIG = {
    "version": "v1",
    "seq_len": DEFAULT_SEQ_LEN,
    "pred_len": DEFAULT_PRED_LEN,
    "patch_len": DEFAULT_PATCH_LEN,
    "stride": DEFAULT_STRIDE,
    "d_model": DEFAULT_D_MODEL,
    "n_heads": DEFAULT_N_HEADS,
    "n_layers": DEFAULT_N_LAYERS,
    "dropout": DEFAULT_DROPOUT,
    "norm_eps": _NORM_EPS,
    "strategy": "channel-independent PatchTST, RevIN per-window, MSE loss + grad clip",
}
