"""Formal TabM artifact training and model_pool registration."""

from __future__ import annotations

import hashlib
import io
import json
import math
import time
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .model_store import _get_bucket
from .prep_lineage import (
    attach_prep_lineage_aliases,
    collect_prep_lineage,
    validate_prep_lineage_for_registration,
)
from .research_benchmarks.common import direction_accuracy, load_tabular_dataset, rank_ic

MODEL_NAME = "TabM"
DEFAULT_BATCH_COUNT = 5
DEFAULT_EPOCHS = 16
DEFAULT_BATCH_SIZE = 1024
DEFAULT_LR = 0.002
DEFAULT_WEIGHT_DECAY = 3e-4
DEFAULT_MAX_ROWS = 120_000
DEFAULT_STANDARDIZATION_CLIP = 8.0
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


def _finite(value: float) -> float:
    return float(value) if math.isfinite(float(value)) else 0.0


def _date_split(dates: np.ndarray, *, test_ratio: float = 0.2, embargo_dates: int = 10) -> tuple[np.ndarray, np.ndarray, dict]:
    unique_dates = np.asarray(sorted({str(date) for date in dates if str(date)}))
    if len(unique_dates) < 40:
        raise ValueError(f"Not enough unique dates for TabM train/test split: {len(unique_dates)}")
    test_count = max(10, int(len(unique_dates) * float(test_ratio)))
    split_at = max(1, len(unique_dates) - test_count)
    train_end = max(1, split_at - max(0, int(embargo_dates)))
    train_dates = set(unique_dates[:train_end])
    test_dates = set(unique_dates[split_at:])
    train_idx = np.asarray([i for i, date in enumerate(dates) if str(date) in train_dates], dtype=np.int64)
    test_idx = np.asarray([i for i, date in enumerate(dates) if str(date) in test_dates], dtype=np.int64)
    if len(train_idx) < 500 or len(test_idx) < 100:
        raise ValueError(f"Insufficient TabM split rows: train={len(train_idx)} test={len(test_idx)}")
    return train_idx, test_idx, {
        "method": "date_holdout_with_embargo",
        "unique_dates": int(len(unique_dates)),
        "embargo_dates": int(embargo_dates),
        "train_range": [str(unique_dates[0]), str(unique_dates[train_end - 1])],
        "validation_range": [str(unique_dates[split_at]), str(unique_dates[-1])],
        "train_dates": int(len(train_dates)),
        "validation_dates": int(len(test_dates)),
    }


def _subsample_indices(indices: np.ndarray, *, max_rows: int) -> np.ndarray:
    if max_rows <= 0 or len(indices) <= max_rows:
        return indices
    keep = np.linspace(0, len(indices) - 1, int(max_rows)).astype(int)
    return indices[keep]


def _robust_standardize(
    x_train: np.ndarray,
    x_all: np.ndarray,
    *,
    clip_value: float | None = DEFAULT_STANDARDIZATION_CLIP,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    medians = np.nanmedian(x_train, axis=0).astype(np.float32)
    q75 = np.nanpercentile(x_train, 75, axis=0).astype(np.float32)
    q25 = np.nanpercentile(x_train, 25, axis=0).astype(np.float32)
    scales = (q75 - q25).astype(np.float32)
    scales = np.where(np.isfinite(scales) & (np.abs(scales) > 1e-9), scales, 1.0).astype(np.float32)
    medians = np.nan_to_num(medians, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32)
    x_scaled = np.nan_to_num((x_all - medians.reshape(1, -1)) / scales.reshape(1, -1), nan=0.0, posinf=0.0, neginf=0.0)
    if clip_value is not None and float(clip_value) > 0:
        x_scaled = np.clip(x_scaled, -float(clip_value), float(clip_value))
    return x_scaled.astype(np.float32), medians, scales


def _build_tabm_ranker(n_features: int):
    from tabm import TabM

    try:
        return TabM.make(n_num_features=n_features, cat_cardinalities=[], d_out=1)
    except TypeError:
        return TabM.make(n_num_features=n_features, d_out=1)


def _tabm_forward(model: Any, x):
    try:
        return model(x)
    except TypeError:
        pass
    try:
        return model(x_num=x, x_cat=None)
    except TypeError:
        pass

    import torch

    x_cat = torch.empty((x.shape[0], 0), dtype=torch.long, device=x.device)
    return model(x, x_cat)


def _reduce_tabm_output(output: Any):
    if isinstance(output, (tuple, list)):
        output = output[0]
    if output.ndim == 3:
        output = output.mean(dim=1)
    return output.reshape(output.shape[0], -1).mean(dim=1)


def _predict_tabm_batches(model: Any, x: np.ndarray, *, batch_size: int, device) -> np.ndarray:
    import torch

    outputs: list[np.ndarray] = []
    model.eval()
    with torch.no_grad():
        for start in range(0, len(x), max(1, batch_size)):
            xb = torch.tensor(x[start:start + batch_size], dtype=torch.float32, device=device)
            pred_raw = _reduce_tabm_output(_tabm_forward(model, xb))
            pred = torch.sigmoid(pred_raw).detach().cpu().numpy().reshape(-1)
            outputs.append(pred)
    return np.concatenate(outputs, axis=0) if outputs else np.array([], dtype=np.float32)


def _save_artifact(*, bucket, model, version: str, metadata: dict) -> dict:
    import torch

    artifact_path = f"universal/tabm/{version}.pt"
    metadata_path = f"universal/tabm/metadata_{version}.json"
    payload = {
        "state_dict": model.state_dict(),
        "architecture": metadata["architecture"],
        "metadata": metadata,
    }
    buf = io.BytesIO()
    torch.save(payload, buf)
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
        "model_type": "tabular_neural_tabm",
        "balance_family": "tabular",
        "promoted_at": promoted_at,
        "last_ic_status": "awaiting_live_ic",
        "last_ic_root_cause": "new_tabm_artifact_awaiting_verified_predictions",
        "last_ic_sample_count": 0,
        "last_artifact_evidence": {
            "oos_ic": metadata.get("oos_ic"),
            "direction_accuracy": metadata.get("direction_accuracy"),
            "validation_range": metadata.get("validation_range"),
            "pred_std": (metadata.get("metrics") or {}).get("pred_std"),
            "prep_lineage": metadata.get("prep_lineage"),
        },
        "promotion_controller": {
            "source": "tabm_formal_retrain",
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
        "note": "Production serving is owned by model_pool.models.TabM; formal slot kept as governance alias.",
        "last_updated": promoted_at,
    })

    pool["last_updated"] = promoted_at
    pool_blob.upload_from_string(
        json.dumps(pool, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"old_version": old_version, "new_version": version, "artifact_path": artifact_path, "promoted_at": promoted_at}


def train_tabm_universal(payload: dict | None = None) -> dict[str, Any]:
    payload = dict(payload or {})
    t0 = time.time()
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    version = str(payload.get("output_model_version") or _version())
    epochs = int(payload.get("epochs") or DEFAULT_EPOCHS)
    batch_size = int(payload.get("batch_size") or DEFAULT_BATCH_SIZE)
    eval_batch_size = int(payload.get("eval_batch_size") or min(batch_size, 1024))
    lr = float(payload.get("lr") or DEFAULT_LR)
    weight_decay = float(payload.get("weight_decay") or DEFAULT_WEIGHT_DECAY)
    max_rows = int(payload.get("max_rows") or payload.get("data_slice", {}).get("max_rows") or DEFAULT_MAX_ROWS)
    standardization_clip = float(
        payload.get("standardization_clip")
        if payload.get("standardization_clip") is not None
        else DEFAULT_STANDARDIZATION_CLIP
    )
    promote_to_active = bool(payload.get("promote_to_active", True))
    payload.setdefault("batch_count", int(payload.get("batch_count") or DEFAULT_BATCH_COUNT))

    dataset = load_tabular_dataset(payload)
    finite_mask = np.isfinite(dataset.y) & np.isfinite(dataset.X).all(axis=1)
    x_raw = np.asarray(dataset.X[finite_mask], dtype=np.float32)
    y = np.clip(np.asarray(dataset.y[finite_mask], dtype=np.float32).reshape(-1), 0.0, 1.0)
    dates = np.asarray(dataset.dates[finite_mask]).astype(str)
    sectors = np.asarray(dataset.sectors[finite_mask]).astype(str)
    if len(y) < 1000:
        raise ValueError(f"TabM training requires at least 1000 finite rows, got {len(y)}")
    gcs_prefix = str(payload.get("gcs_prefix") or payload.get("data_slice", {}).get("gcs_prefix") or "universal").strip().rstrip("/")
    prep_lineage = collect_prep_lineage(
        bucket,
        gcs_prefix=gcs_prefix,
        batch_count=int(payload.get("batch_count") or DEFAULT_BATCH_COUNT),
        feature_names=dataset.feature_names,
        rows=len(y),
        dates=dates,
    )
    prep_freshness = (
        validate_prep_lineage_for_registration(
            prep_lineage,
            as_of_date=payload.get("as_of_date") or payload.get("run_date"),
            max_stale_days=payload.get("max_prep_stale_days"),
            label_horizon_days=payload.get("label_horizon_days"),
        )
        if promote_to_active
        and dataset.source.startswith("gs://")
        and gcs_prefix == "universal"
        and payload.get("disable_stale_prep_guard") is not True
        else {"status": "skipped"}
    )

    train_idx, test_idx, split_meta = _date_split(
        dates,
        test_ratio=float(payload.get("test_ratio") or 0.2),
        embargo_dates=int(payload.get("embargo_dates") or 10),
    )
    train_fit_idx = _subsample_indices(train_idx, max_rows=max_rows)
    x, medians, scales = _robust_standardize(x_raw[train_fit_idx], x_raw, clip_value=standardization_clip)

    import torch
    import torch.nn.functional as F

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = _build_tabm_ranker(x.shape[1]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    x_train = torch.tensor(x[train_fit_idx], dtype=torch.float32)
    y_train = torch.tensor(y[train_fit_idx], dtype=torch.float32)
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(x_train, y_train),
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
            pred = torch.sigmoid(_reduce_tabm_output(_tabm_forward(model, xb)))
            loss = F.smooth_l1_loss(pred, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=3.0)
            optimizer.step()
            losses.append(float(loss.detach().cpu().item()))
        train_losses.append(round(float(np.mean(losses)), 6) if losses else 0.0)

    pred = _predict_tabm_batches(model, x[test_idx], batch_size=eval_batch_size, device=device)
    y_test = y[test_idx]
    metrics = {
        "oos_ic": round(_finite(rank_ic(pred, y_test)), 6),
        "direction_accuracy": round(_finite(direction_accuracy(pred - 0.5, y_test - 0.5)), 6),
        "samples": int(len(y_test)),
        "pred_std": round(float(np.std(pred)), 6),
        "loss_first": train_losses[0] if train_losses else None,
        "loss_last": train_losses[-1] if train_losses else None,
    }

    trained_at = datetime.now(timezone.utc).isoformat()
    architecture = {
        "type": "tabm",
        "n_features": int(x.shape[1]),
    }
    metadata = attach_prep_lineage_aliases({
        "schema_version": "tabm_formal_artifact_v1",
        "artifact_schema": "torch_tabm_ranker_v1",
        "version": version,
        "model_name": MODEL_NAME,
        "model_type": "tabular_neural_tabm",
        "family": "tabular_neural",
        "trained_at": trained_at,
        "feature_names": dataset.feature_names,
        "feature_count": len(dataset.feature_names),
        "feature_medians": {name: float(medians[i]) for i, name in enumerate(dataset.feature_names)},
        "feature_standardization": {
            "method": "robust_median_iqr",
            "medians": [float(value) for value in medians.tolist()],
            "scales": [float(value) for value in scales.tolist()],
            "clip_value": standardization_clip,
        },
        "architecture": architecture,
        "output_transform": "sigmoid",
        "metrics": metrics,
        "oos_ic": metrics["oos_ic"],
        "direction_accuracy": metrics["direction_accuracy"],
        "train_range": split_meta["train_range"],
        "validation_range": split_meta["validation_range"],
        "validation_split": split_meta,
        "sample_count": int(len(train_fit_idx)),
        "validation_sample_count": int(len(test_idx)),
        "dataset_snapshot": {
            "source": dataset.source,
            "batch_count": int(payload.get("batch_count") or DEFAULT_BATCH_COUNT),
            "max_rows": max_rows,
            "prep_lineage": prep_lineage,
            "prep_freshness": prep_freshness,
        },
        "feature_policy": {
            "model": MODEL_NAME,
            "family": "tabular_neural",
            "feature_policy_type": "tabm_artifact_required",
            "feature_source": "universal/prep feature matrix",
            "selection_method": "production_artifact",
        },
        "training_params": {
            "epochs": epochs,
            "batch_size": batch_size,
            "lr": lr,
            "weight_decay": weight_decay,
            "standardization_clip": standardization_clip,
            "device": str(device),
        },
        "market_lanes": sorted({str(value) for value in sectors.tolist()})[:20],
    }, prep_lineage)
    saved = _save_artifact(bucket=bucket, model=model.cpu(), version=version, metadata=metadata)
    pool_update = (
        _update_model_pool_active(
            bucket,
            version=version,
            artifact_path=saved["artifact_path"],
            metadata=saved["metadata"],
            reason=str(payload.get("promotion_reason") or "formal TabM artifact retrain approved by Wei"),
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
        "train_samples": int(len(train_fit_idx)),
        "validation_samples": int(len(test_idx)),
        "feature_count": len(dataset.feature_names),
        "pool_update": pool_update,
        "elapsed_s": round(time.time() - t0, 3),
    }
