"""Formal iTransformer artifact training and model_pool registration."""

from __future__ import annotations

import hashlib
import io
import json
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .itransformer_universal import (
    DEFAULT_D_MODEL,
    DEFAULT_DROPOUT,
    DEFAULT_N_HEADS,
    DEFAULT_N_LAYERS,
    DEFAULT_PRED_LEN,
    DEFAULT_SEQ_LEN,
    GCS_WEIGHTS_PREFIX,
    _build_model,
    _normalize,
)
from .model_store import _get_bucket
from .research_benchmarks.common import direction_accuracy, load_sequence_dataset, rank_ic
from .sequence_training import build_sequence_window_dataset, sequence_oos_ic_from_forecast

MODEL_NAME = "iTransformer"
DEFAULT_BATCH_COUNT = 5
DEFAULT_EPOCHS = 12
DEFAULT_BATCH_SIZE = 256
DEFAULT_LR = 5e-4
DEFAULT_WEIGHT_DECAY = 1e-5
DEFAULT_MAX_WINDOWS = 16_000
STALE_PROMOTION_FIELDS = (
    "artifact_backfill",
    "ic_4w_avg",
    "last_ic_by_segment",
    "model_cpcv",
    "rolling_ic",
    "weekly_ic",
)


def _version() -> str:
    return "v" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")


def _subsample_rows(x: np.ndarray, y: np.ndarray, *, max_rows: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    idx = np.arange(len(x), dtype=np.int64)
    if max_rows > 0 and len(idx) > max_rows:
        idx = np.linspace(0, len(idx) - 1, int(max_rows)).astype(np.int64)
    return x[idx], y[idx], idx


def _save_artifact(*, bucket, model, version: str, metadata: dict) -> dict:
    import torch

    artifact_path = f"{GCS_WEIGHTS_PREFIX}/{version}.pt"
    metadata_path = f"{GCS_WEIGHTS_PREFIX}/metadata_{version}.json"
    buf = io.BytesIO()
    torch.save({"state_dict": model.state_dict()}, buf)
    raw = buf.getvalue()
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    bucket.blob(artifact_path).upload_from_string(raw, content_type="application/octet-stream")
    metadata = {**metadata, "checksum": checksum, "artifact_path": artifact_path, "metadata_path": metadata_path}
    bucket.blob(metadata_path).upload_from_string(
        json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"artifact_path": artifact_path, "metadata_path": metadata_path, "checksum": checksum, "metadata": metadata}


def _update_model_pool_active(bucket, *, version: str, artifact_path: str, metadata: dict, reason: str) -> dict:
    pool_blob = bucket.blob("universal/model_pool.json")
    if not pool_blob.exists():
        raise RuntimeError("universal/model_pool.json not found")
    pool = json.loads(pool_blob.download_as_text().lstrip("\ufeff"))
    entry = (pool.setdefault("models", {})).setdefault(MODEL_NAME, {})
    old_version = entry.get("version")
    promoted_at = datetime.now(timezone.utc).isoformat()
    if old_version and str(old_version) != str(version):
        entry.setdefault("retired_versions", []).append({
            "version": old_version,
            "gcs_path": entry.get("gcs_path"),
            "retired_at": promoted_at,
            "reason": reason,
            "weekly_ic_at_retire": list(entry.get("weekly_ic") or []),
            "ic_4w_avg_at_retire": entry.get("ic_4w_avg"),
        })
    entry.update({
        "status": "active",
        "version": version,
        "gcs_path": artifact_path,
        "model_type": "time_series_transformer",
        "balance_family": "time_series",
        "promoted_at": promoted_at,
        "last_ic_status": "awaiting_live_ic",
        "last_ic_root_cause": "new_itransformer_artifact_awaiting_verified_predictions",
        "last_ic_sample_count": 0,
        "last_artifact_evidence": {
            "oos_ic": metadata.get("oos_ic"),
            "direction_accuracy": metadata.get("direction_accuracy"),
            "validation_range": metadata.get("validation_range"),
            "oos_samples": (metadata.get("metrics") or {}).get("oos_samples"),
        },
        "promotion_controller": {
            "source": "itransformer_formal_retrain",
            "reason": reason,
            "promoted_at": promoted_at,
            "artifact_path": artifact_path,
        },
    })
    for field in STALE_PROMOTION_FIELDS:
        entry.pop(field, None)
    entry.pop("challenger", None)
    entry.pop("degraded_since", None)
    entry.pop("retired_at", None)

    slot = (pool.setdefault("formal_layer3_slots", {})).setdefault(MODEL_NAME, {})
    slot.update({
        "status": "artifact_backed_model_pool_active",
        "version": version,
        "gcs_path": artifact_path,
        "direct_prediction": False,
        "vote_weight": 0.0,
        "note": "Production serving is owned by model_pool.models.iTransformer; formal slot kept as governance alias.",
        "last_updated": promoted_at,
    })

    pool["last_updated"] = promoted_at
    pool_blob.upload_from_string(
        json.dumps(pool, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"old_version": old_version, "new_version": version, "artifact_path": artifact_path, "promoted_at": promoted_at}


def train_itransformer_universal(payload: dict | None = None) -> dict[str, Any]:
    payload = dict(payload or {})
    t0 = time.time()
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    version = str(payload.get("output_model_version") or _version())
    seq_len = int(payload.get("seq_len") or payload.get("data_slice", {}).get("seq_len") or DEFAULT_SEQ_LEN)
    pred_len = int(payload.get("pred_len") or payload.get("data_slice", {}).get("pred_len") or DEFAULT_PRED_LEN)
    d_model = int(payload.get("d_model") or DEFAULT_D_MODEL)
    n_heads = int(payload.get("n_heads") or DEFAULT_N_HEADS)
    n_layers = int(payload.get("n_layers") or DEFAULT_N_LAYERS)
    dropout = float(payload.get("dropout") if payload.get("dropout") is not None else DEFAULT_DROPOUT)
    epochs = int(payload.get("epochs") or DEFAULT_EPOCHS)
    batch_size = int(payload.get("batch_size") or DEFAULT_BATCH_SIZE)
    lr = float(payload.get("lr") or DEFAULT_LR)
    weight_decay = float(payload.get("weight_decay") or DEFAULT_WEIGHT_DECAY)
    max_windows = int(payload.get("max_windows") or payload.get("data_slice", {}).get("max_windows") or DEFAULT_MAX_WINDOWS)
    promote_to_active = bool(payload.get("promote_to_active", True))
    payload.setdefault("batch_count", int(payload.get("batch_count") or DEFAULT_BATCH_COUNT))

    dataset_source = load_sequence_dataset(payload)
    window_dataset = build_sequence_window_dataset(
        dataset_source.records,
        seq_len=seq_len,
        pred_len=pred_len,
        oos_ratio=float(payload.get("oos_ratio") or 0.2),
    )
    if not window_dataset.report.get("lifecycle_ready"):
        raise ValueError(f"iTransformer sequence dataset not lifecycle ready: {window_dataset.report}")

    x_train, y_train, sampled_train_idx = _subsample_rows(
        window_dataset.X_train,
        window_dataset.y_train,
        max_rows=max_windows,
    )
    x_train_norm, mean_train, std_train = _normalize(x_train)
    y_train_norm = (y_train - mean_train) / std_train
    x_oos_norm, mean_oos, std_oos = _normalize(window_dataset.X_oos)

    import torch

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = _build_model(
        seq_len=seq_len,
        pred_len=pred_len,
        d_model=d_model,
        n_heads=n_heads,
        n_layers=n_layers,
        dropout=dropout,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    criterion = torch.nn.MSELoss()
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(
            torch.tensor(x_train_norm, dtype=torch.float32),
            torch.tensor(y_train_norm, dtype=torch.float32),
        ),
        batch_size=batch_size,
        shuffle=True,
    )
    train_losses: list[float] = []
    model.train()
    for _epoch in range(max(1, epochs)):
        losses: list[float] = []
        for xb, yb in loader:
            xb = xb.to(device)
            yb = yb.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(xb), yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=3.0)
            optimizer.step()
            losses.append(float(loss.detach().cpu().item()))
        train_losses.append(round(float(np.mean(losses)), 6) if losses else 0.0)

    model.eval()
    with torch.no_grad():
        forecast_norm = model(torch.tensor(x_oos_norm, dtype=torch.float32, device=device)).detach().cpu().numpy()
    forecast = forecast_norm * std_oos + mean_oos
    forecast_last = forecast[:, -1]
    actual_last = window_dataset.y_oos[:, -1]
    last_close = np.asarray([window_dataset.meta[int(idx)]["last_close"] for idx in window_dataset.oos_index], dtype=float)
    pred_return = (forecast_last - last_close) / np.maximum(last_close, 1e-9)
    actual_return = (actual_last - last_close) / np.maximum(last_close, 1e-9)
    ic_metrics = sequence_oos_ic_from_forecast(forecast_prices=forecast_last, dataset=window_dataset)
    metrics = {
        **ic_metrics,
        "oos_ic": round(float(ic_metrics.get("oos_ic") or 0.0), 6),
        "direction_accuracy": round(float(direction_accuracy(pred_return, actual_return)), 6),
        "rank_ic_all": round(float(rank_ic(pred_return, actual_return)), 6),
        "pred_return_std": round(float(np.std(pred_return)), 6),
        "loss_first": train_losses[0] if train_losses else None,
        "loss_last": train_losses[-1] if train_losses else None,
    }

    target_dates = [window_dataset.meta[int(idx)]["target_date"] for idx in window_dataset.oos_index]
    trained_at = datetime.now(timezone.utc).isoformat()
    metadata = {
        "schema_version": "itransformer_formal_artifact_v1",
        "artifact_schema": "torch_itransformer_universal_v1",
        "version": version,
        "model_name": MODEL_NAME,
        "model_type": "time_series_transformer",
        "family": "time_series",
        "trained_at": trained_at,
        "seq_len": seq_len,
        "pred_len": pred_len,
        "d_model": d_model,
        "n_heads": n_heads,
        "n_layers": n_layers,
        "dropout": dropout,
        "metrics": metrics,
        "oos_ic": metrics["oos_ic"],
        "direction_accuracy": metrics["direction_accuracy"],
        "train_range": [
            min(str(window_dataset.meta[int(idx)]["target_date"]) for idx in window_dataset.train_index),
            max(str(window_dataset.meta[int(idx)]["target_date"]) for idx in window_dataset.train_index),
        ],
        "validation_range": [min(target_dates), max(target_dates)],
        "sample_count": int(len(sampled_train_idx)),
        "validation_sample_count": int(len(window_dataset.oos_index)),
        "dataset_snapshot": {
            "source": dataset_source.source,
            "batch_count": int(payload.get("batch_count") or DEFAULT_BATCH_COUNT),
            "sequence_report": window_dataset.report,
            "max_windows": max_windows,
        },
        "feature_policy": {
            "model": MODEL_NAME,
            "family": "time_series",
            "feature_policy_type": "sequence_artifact_required",
            "feature_source": "universal/prep sequence_records",
            "selection_method": "production_artifact",
        },
        "training_params": {
            "epochs": epochs,
            "batch_size": batch_size,
            "lr": lr,
            "weight_decay": weight_decay,
            "device": str(device),
        },
    }
    saved = _save_artifact(bucket=bucket, model=model.cpu(), version=version, metadata=metadata)
    pool_update = (
        _update_model_pool_active(
            bucket,
            version=version,
            artifact_path=saved["artifact_path"],
            metadata=saved["metadata"],
            reason=str(payload.get("promotion_reason") or "formal iTransformer artifact retrain approved by Wei"),
        )
        if promote_to_active
        else None
    )
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "version": version,
        "artifact_path": saved["artifact_path"],
        "metadata_path": saved["metadata_path"],
        "checksum": saved["checksum"],
        "metrics": saved["metadata"]["metrics"],
        "oos_ic": saved["metadata"]["oos_ic"],
        "train_samples": int(len(sampled_train_idx)),
        "validation_samples": int(len(window_dataset.oos_index)),
        "pool_update": pool_update,
        "elapsed_s": round(time.time() - t0, 3),
    }
