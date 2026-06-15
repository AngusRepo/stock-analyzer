"""Formal GraphSAGE artifact training for the GNN alpha family.

The serving runtime scores a full candidate universe with a GraphSAGE model and
batch-built price-correlation edges. This trainer produces the compatible
``.pt`` payload from real universal prep batches and updates model_pool.json only
after the artifact has been written to GCS.
"""

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

MODEL_NAME = "GNN"
DEFAULT_BATCH_COUNT = 5
DEFAULT_EPOCHS = 36
DEFAULT_HIDDEN_DIM = 64
DEFAULT_DROPOUT = 0.12
DEFAULT_LR = 0.003
DEFAULT_WEIGHT_DECAY = 1e-4
DEFAULT_MAX_TRAIN_DATES_PER_EPOCH = 120
DEFAULT_EDGE_TOP_K = 8
DEFAULT_EDGE_THRESHOLD = 0.25
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


def _spearman(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) < 10:
        return 0.0
    xr = np.argsort(np.argsort(np.asarray(x, dtype=float)))
    yr = np.argsort(np.argsort(np.asarray(y, dtype=float)))
    if np.std(xr) < 1e-10 or np.std(yr) < 1e-10:
        return 0.0
    value = float(np.corrcoef(xr, yr)[0, 1])
    return 0.0 if not math.isfinite(value) else value


def _load_npz_batches(bucket, *, gcs_prefix: str, batch_count: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict]:
    all_x: list[np.ndarray] = []
    all_y: list[np.ndarray] = []
    all_dates: list[np.ndarray] = []
    all_sectors: list[np.ndarray] = []
    io_report = {"prep_objects": 0, "prep_bytes": 0}
    for idx in range(max(1, int(batch_count))):
        key = f"{gcs_prefix}/prep/batch_{idx}.npz"
        blob = bucket.blob(key)
        if not blob.exists():
            continue
        raw = blob.download_as_bytes()
        io_report["prep_objects"] += 1
        io_report["prep_bytes"] += len(raw)
        data = np.load(io.BytesIO(raw), allow_pickle=True)
        all_x.append(np.asarray(data["X"], dtype=np.float32))
        all_y.append(np.asarray(data["y"], dtype=np.float32).reshape(-1))
        all_dates.append(np.asarray(data["dates"]).astype(str).reshape(-1))
        sectors = data["sectors"] if "sectors" in data.files else np.array(["unknown"] * len(data["X"]), dtype=object)
        all_sectors.append(np.asarray(sectors).astype(str).reshape(-1))
    if not all_x:
        raise ValueError(f"No prep batches found at {gcs_prefix}/prep/batch_*.npz")
    x = np.concatenate(all_x, axis=0)
    y = np.concatenate(all_y, axis=0)
    dates = np.concatenate(all_dates, axis=0)
    sectors = np.concatenate(all_sectors, axis=0)
    if not (len(x) == len(y) == len(dates) == len(sectors)):
        raise ValueError("GNN prep arrays are not aligned")
    return x, y, dates, sectors, io_report


def _load_feature_names(bucket, *, gcs_prefix: str, n_features: int) -> list[str]:
    blob = bucket.blob(f"{gcs_prefix}/prep/feature_names.json")
    if not blob.exists():
        return [f"f{i}" for i in range(n_features)]
    names = json.loads(blob.download_as_text())
    if not isinstance(names, list) or len(names) != n_features:
        raise ValueError(f"feature_names width mismatch: names={len(names) if isinstance(names, list) else 'invalid'} X={n_features}")
    return [str(name) for name in names]


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


def _date_split(dates: np.ndarray, *, test_ratio: float = 0.2, embargo_dates: int = 10) -> tuple[np.ndarray, np.ndarray, dict]:
    unique_dates = np.asarray(sorted({str(date) for date in dates if str(date)}))
    if len(unique_dates) < 60:
        raise ValueError(f"Not enough unique dates for GNN train/test split: {len(unique_dates)}")
    test_count = max(20, int(len(unique_dates) * float(test_ratio)))
    split_at = max(1, len(unique_dates) - test_count)
    train_end = max(1, split_at - max(0, int(embargo_dates)))
    train_dates = set(unique_dates[:train_end])
    test_dates = set(unique_dates[split_at:])
    train_idx = np.asarray([i for i, date in enumerate(dates) if str(date) in train_dates], dtype=np.int64)
    test_idx = np.asarray([i for i, date in enumerate(dates) if str(date) in test_dates], dtype=np.int64)
    if len(train_idx) < 500 or len(test_idx) < 100:
        raise ValueError(f"Insufficient GNN split rows: train={len(train_idx)} test={len(test_idx)}")
    return train_idx, test_idx, {
        "method": "date_holdout_with_embargo",
        "unique_dates": int(len(unique_dates)),
        "embargo_dates": int(embargo_dates),
        "train_range": [str(unique_dates[0]), str(unique_dates[train_end - 1])],
        "validation_range": [str(unique_dates[split_at]), str(unique_dates[-1])],
        "train_dates": int(len(train_dates)),
        "validation_dates": int(len(test_dates)),
    }


def _group_by_date(indices: np.ndarray, dates: np.ndarray) -> list[np.ndarray]:
    groups: dict[str, list[int]] = {}
    for idx in indices.tolist():
        groups.setdefault(str(dates[idx]), []).append(int(idx))
    return [np.asarray(values, dtype=np.int64) for _date, values in sorted(groups.items()) if len(values) >= 2]


def _feature_edge_index(x_date: np.ndarray, sectors: np.ndarray, *, top_k: int, threshold: float) -> np.ndarray:
    n = int(x_date.shape[0])
    if n <= 1:
        return np.zeros((2, 0), dtype=np.int64)
    x = np.asarray(x_date, dtype=np.float32)
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    norms = np.where(norms > 1e-9, norms, 1.0)
    sim = (x / norms) @ (x / norms).T
    sim = np.nan_to_num(sim, nan=0.0, posinf=0.0, neginf=0.0)
    np.fill_diagonal(sim, 0.0)
    edges: set[tuple[int, int]] = set()
    abs_sim = np.abs(sim)
    k = max(1, min(int(top_k), n - 1))
    for i in range(n):
        ranked = np.argsort(abs_sim[i])[::-1][:k]
        for j_raw in ranked:
            j = int(j_raw)
            if i == j:
                continue
            same_sector = str(sectors[i]) == str(sectors[j])
            if abs_sim[i, j] >= float(threshold) or same_sector:
                edges.add((i, j))
                edges.add((j, i))
    if not edges:
        for i in range(n - 1):
            edges.add((i, i + 1))
            edges.add((i + 1, i))
    return np.asarray(sorted(edges), dtype=np.int64).T


def _build_model(*, n_features: int, hidden_dim: int, dropout: float):
    import torch.nn as nn
    from torch_geometric.nn import SAGEConv

    class GraphSAGERankModel(nn.Module):
        def __init__(self):
            super().__init__()
            self.conv1 = SAGEConv(n_features, hidden_dim)
            self.conv2 = SAGEConv(hidden_dim, hidden_dim)
            self.dropout = nn.Dropout(dropout)
            self.head = nn.Linear(hidden_dim, 1)

        def forward(self, x, edge_index):
            h = self.conv1(x, edge_index).relu()
            h = self.dropout(h)
            h = self.conv2(h, edge_index).relu()
            return self.head(h).reshape(-1)

    return GraphSAGERankModel()


def _evaluate(model, *, groups: list[np.ndarray], x: np.ndarray, y: np.ndarray, sectors: np.ndarray, device, top_k: int, threshold: float) -> dict:
    import torch

    model.eval()
    all_pred: list[np.ndarray] = []
    all_y: list[np.ndarray] = []
    daily_ics: list[float] = []
    with torch.no_grad():
        for idx in groups:
            edge_np = _feature_edge_index(x[idx], sectors[idx], top_k=top_k, threshold=threshold)
            xb = torch.tensor(x[idx], dtype=torch.float32, device=device)
            yb = y[idx]
            edge = torch.tensor(edge_np, dtype=torch.long, device=device)
            pred = torch.sigmoid(model(xb, edge)).detach().cpu().numpy().reshape(-1)
            all_pred.append(pred)
            all_y.append(np.asarray(yb, dtype=np.float32).reshape(-1))
            daily_ics.append(_spearman(pred, yb))
    pred_all = np.concatenate(all_pred) if all_pred else np.asarray([], dtype=float)
    y_all = np.concatenate(all_y) if all_y else np.asarray([], dtype=float)
    return {
        "oos_ic": round(_spearman(pred_all, y_all), 6),
        "daily_ic_mean": round(float(np.mean(daily_ics)), 6) if daily_ics else 0.0,
        "daily_ic_count": len(daily_ics),
        "samples": int(len(y_all)),
        "pred_std": round(float(np.std(pred_all)), 6) if len(pred_all) else 0.0,
    }


def _save_artifact(
    *,
    bucket,
    model,
    version: str,
    metadata: dict,
) -> dict:
    import torch

    artifact_path = f"universal/gnn/{version}.pt"
    metadata_path = f"universal/gnn/metadata_{version}.json"
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
        "model_type": "cross_stock_graphsage",
        "balance_family": "graph",
        "promoted_at": promoted_at,
        "last_ic_status": "awaiting_live_ic",
        "last_ic_root_cause": "new_graphsage_artifact_awaiting_verified_predictions",
        "last_ic_sample_count": 0,
        "last_artifact_evidence": {
            "oos_ic": metadata.get("oos_ic"),
            "daily_ic_count": metadata.get("daily_ic_count"),
            "validation_range": metadata.get("validation_range"),
            "prep_lineage": metadata.get("prep_lineage"),
        },
        "promotion_controller": {
            "source": "graphsage_formal_retrain",
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
        "model_type": "cross_stock_graphsage",
        "family": "graph",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "last_updated": promoted_at,
        "note": "Production serving is owned by model_pool.models.GNN; formal slot kept as governance alias.",
    })
    pool["last_updated"] = promoted_at
    pool_blob.upload_from_string(
        json.dumps(pool, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"old_version": old_version, "new_version": version, "artifact_path": artifact_path, "promoted_at": promoted_at}


def train_graphsage_universal(payload: dict | None = None) -> dict[str, Any]:
    payload = dict(payload or {})
    t0 = time.time()
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    gcs_prefix = str(payload.get("gcs_prefix") or "universal").strip().rstrip("/")
    batch_count = int(payload.get("batch_count") or DEFAULT_BATCH_COUNT)
    version = str(payload.get("output_model_version") or _version())
    epochs = int(payload.get("epochs") or DEFAULT_EPOCHS)
    hidden_dim = int(payload.get("hidden_dim") or DEFAULT_HIDDEN_DIM)
    dropout = float(payload.get("dropout") if payload.get("dropout") is not None else DEFAULT_DROPOUT)
    lr = float(payload.get("lr") or DEFAULT_LR)
    weight_decay = float(payload.get("weight_decay") or DEFAULT_WEIGHT_DECAY)
    max_train_dates_per_epoch = int(payload.get("max_train_dates_per_epoch") or DEFAULT_MAX_TRAIN_DATES_PER_EPOCH)
    edge_top_k = int(payload.get("edge_top_k") or DEFAULT_EDGE_TOP_K)
    edge_threshold = float(payload.get("edge_threshold") if payload.get("edge_threshold") is not None else DEFAULT_EDGE_THRESHOLD)
    standardization_clip = float(
        payload.get("standardization_clip")
        if payload.get("standardization_clip") is not None
        else DEFAULT_STANDARDIZATION_CLIP
    )
    promote_to_active = bool(payload.get("promote_to_active", True))

    x_raw, y, dates, sectors, io_report = _load_npz_batches(bucket, gcs_prefix=gcs_prefix, batch_count=batch_count)
    feature_names = _load_feature_names(bucket, gcs_prefix=gcs_prefix, n_features=x_raw.shape[1])
    finite_mask = np.isfinite(y)
    x_raw = x_raw[finite_mask]
    y = np.clip(y[finite_mask], 0.0, 1.0).astype(np.float32)
    dates = dates[finite_mask]
    sectors = sectors[finite_mask]
    prep_lineage = collect_prep_lineage(
        bucket,
        gcs_prefix=gcs_prefix,
        batch_count=batch_count,
        feature_names=feature_names,
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
        if promote_to_active and gcs_prefix == "universal" and payload.get("disable_stale_prep_guard") is not True
        else {"status": "skipped"}
    )

    train_idx, test_idx, split_meta = _date_split(
        dates,
        test_ratio=float(payload.get("test_ratio") or 0.2),
        embargo_dates=int(payload.get("embargo_dates") or 10),
    )
    x, medians, scales = _robust_standardize(x_raw[train_idx], x_raw, clip_value=standardization_clip)
    train_groups = _group_by_date(train_idx, dates)
    test_groups = _group_by_date(test_idx, dates)
    if not train_groups or not test_groups:
        raise ValueError("GNN training requires non-empty train/test date groups")

    import torch
    import torch.nn.functional as F

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = _build_model(n_features=x.shape[1], hidden_dim=hidden_dim, dropout=dropout).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    rng = np.random.default_rng(int(payload.get("seed") or 42))
    train_losses: list[float] = []

    for epoch in range(max(1, epochs)):
        model.train()
        groups = list(train_groups)
        rng.shuffle(groups)
        groups = groups[: max(1, min(max_train_dates_per_epoch, len(groups)))]
        epoch_losses: list[float] = []
        for idx in groups:
            edge_np = _feature_edge_index(x[idx], sectors[idx], top_k=edge_top_k, threshold=edge_threshold)
            xb = torch.tensor(x[idx], dtype=torch.float32, device=device)
            yb = torch.tensor(y[idx], dtype=torch.float32, device=device)
            edge = torch.tensor(edge_np, dtype=torch.long, device=device)
            optimizer.zero_grad(set_to_none=True)
            pred = torch.sigmoid(model(xb, edge))
            loss = F.smooth_l1_loss(pred, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=3.0)
            optimizer.step()
            epoch_losses.append(float(loss.detach().cpu().item()))
        train_losses.append(round(float(np.mean(epoch_losses)), 6) if epoch_losses else 0.0)

    eval_metrics = _evaluate(
        model,
        groups=test_groups,
        x=x,
        y=y,
        sectors=sectors,
        device=device,
        top_k=edge_top_k,
        threshold=edge_threshold,
    )
    train_eval = _evaluate(
        model,
        groups=train_groups[-min(60, len(train_groups)):],
        x=x,
        y=y,
        sectors=sectors,
        device=device,
        top_k=edge_top_k,
        threshold=edge_threshold,
    )

    trained_at = datetime.now(timezone.utc).isoformat()
    architecture = {
        "type": "graphsage",
        "n_features": int(x.shape[1]),
        "hidden_dim": hidden_dim,
        "dropout": dropout,
    }
    metadata = attach_prep_lineage_aliases({
        "schema_version": "graphsage_formal_artifact_v1",
        "artifact_schema": "torch_graphsage_ranker_v1",
        "version": version,
        "model_name": MODEL_NAME,
        "model_type": "graphsage",
        "family": "cross_stock_graph",
        "trained_at": trained_at,
        "feature_names": feature_names,
        "feature_count": len(feature_names),
        "feature_medians": {name: float(medians[i]) for i, name in enumerate(feature_names)},
        "feature_standardization": {
            "method": "robust_median_iqr",
            "medians": [float(v) for v in medians.tolist()],
            "scales": [float(v) for v in scales.tolist()],
            "clip_value": standardization_clip,
        },
        "architecture": architecture,
        "graph_context": {
            "training_edge_source": "same_date_feature_similarity",
            "serving_edge_source": "price_correlation_full_universe",
            "correlation_lookback": int(payload.get("correlation_lookback") or 60),
            "correlation_threshold": float(payload.get("correlation_threshold") or 0.35),
            "top_k": int(payload.get("serving_top_k") or 8),
            "training_edge_top_k": edge_top_k,
            "training_edge_threshold": edge_threshold,
        },
        "metrics": {
            **eval_metrics,
            "train_recent_daily_ic_mean": train_eval.get("daily_ic_mean"),
            "train_recent_samples": train_eval.get("samples"),
            "loss_last": train_losses[-1] if train_losses else None,
            "loss_first": train_losses[0] if train_losses else None,
        },
        "oos_ic": eval_metrics["oos_ic"],
        "daily_ic_count": eval_metrics["daily_ic_count"],
        "train_range": split_meta["train_range"],
        "validation_range": split_meta["validation_range"],
        "validation_split": split_meta,
        "sample_count": int(len(train_idx)),
        "validation_sample_count": int(len(test_idx)),
        "dataset_snapshot": {
            "gcs_prefix": gcs_prefix,
            "prep_objects": io_report["prep_objects"],
            "prep_bytes": io_report["prep_bytes"],
            "prep_lineage": prep_lineage,
            "prep_freshness": prep_freshness,
        },
        "feature_policy": {
            "model": MODEL_NAME,
            "family": "cross_stock_graph",
            "feature_policy_type": "graph_artifact_required",
            "feature_source": "universal/prep feature matrix",
            "selection_method": "production_artifact",
        },
        "training_params": {
            "epochs": epochs,
            "hidden_dim": hidden_dim,
            "dropout": dropout,
            "lr": lr,
            "weight_decay": weight_decay,
            "max_train_dates_per_epoch": max_train_dates_per_epoch,
            "standardization_clip": standardization_clip,
            "device": str(device),
        },
    }, prep_lineage)
    saved = _save_artifact(bucket=bucket, model=model.cpu(), version=version, metadata=metadata)
    pool_update = (
        _update_model_pool_active(
            bucket,
            version=version,
            artifact_path=saved["artifact_path"],
            metadata=saved["metadata"],
            reason=str(payload.get("promotion_reason") or "formal GraphSAGE artifact retrain approved by Wei"),
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
        "daily_ic_count": saved["metadata"]["daily_ic_count"],
        "train_samples": int(len(train_idx)),
        "validation_samples": int(len(test_idx)),
        "feature_count": len(feature_names),
        "pool_update": pool_update,
        "elapsed_s": round(time.time() - t0, 3),
    }
