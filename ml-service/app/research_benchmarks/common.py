from __future__ import annotations

import io
import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass
class TabularBenchmarkDataset:
    X: np.ndarray
    y: np.ndarray
    dates: np.ndarray
    sectors: np.ndarray
    feature_names: list[str]
    source: str


@dataclass
class SequenceBenchmarkDataset:
    records: list[dict[str, Any]]
    source: str


def rank_ic(pred: np.ndarray, actual: np.ndarray) -> float:
    pred = np.asarray(pred, dtype=float).reshape(-1)
    actual = np.asarray(actual, dtype=float).reshape(-1)
    mask = np.isfinite(pred) & np.isfinite(actual)
    pred = pred[mask]
    actual = actual[mask]
    if len(pred) < 2:
        return 0.0
    try:
        from scipy.stats import spearmanr

        value = spearmanr(pred, actual).correlation
        return float(value) if math.isfinite(float(value)) else 0.0
    except Exception:
        pred_rank = np.argsort(np.argsort(pred))
        actual_rank = np.argsort(np.argsort(actual))
        if np.std(pred_rank) == 0 or np.std(actual_rank) == 0:
            return 0.0
        return float(np.corrcoef(pred_rank, actual_rank)[0, 1])


def direction_accuracy(pred: np.ndarray, actual: np.ndarray) -> float:
    pred = np.asarray(pred, dtype=float).reshape(-1)
    actual = np.asarray(actual, dtype=float).reshape(-1)
    mask = np.isfinite(pred) & np.isfinite(actual) & (pred != 0) & (actual != 0)
    if not mask.any():
        return 0.0
    return float(np.mean(np.sign(pred[mask]) == np.sign(actual[mask])))


def cpcv_proxy_pbo(fold_metrics: list[dict[str, Any]]) -> float | None:
    ics = [float(row.get("oos_ic", 0.0)) for row in fold_metrics if row.get("oos_ic") is not None]
    if not ics:
        return None
    return round(sum(1 for value in ics if value <= 0.0) / len(ics), 6)


def contiguous_fold_indices(n_rows: int, *, n_folds: int = 5) -> list[tuple[np.ndarray, np.ndarray]]:
    n_folds = max(2, min(int(n_folds or 5), max(2, n_rows // 30)))
    indices = np.arange(n_rows)
    folds = np.array_split(indices, n_folds)
    result: list[tuple[np.ndarray, np.ndarray]] = []
    for fold in folds:
        if len(fold) == 0:
            continue
        train = indices[indices < fold[0]]
        if len(train) < 30:
            train = indices[indices > fold[-1]]
        if len(train) >= 30 and len(fold) >= 10:
            result.append((train, fold))
    return result


def cost_sensitivity(started_at: float, *, gpu: str | None, rows: int, folds: int) -> dict[str, Any]:
    elapsed = max(0.0, time.time() - started_at)
    return {
        "status": "available",
        "latency_sec": round(elapsed, 3),
        "estimated_modal_usd": None,
        "gpu": gpu,
        "rows": int(rows),
        "folds": int(folds),
        "notes": "Modal cost is recorded by controller telemetry; adapter reports wall-clock and data volume.",
    }


def data_slice_report(*, dataset: TabularBenchmarkDataset | SequenceBenchmarkDataset, start_date: str | None, end_date: str | None) -> dict[str, Any]:
    if isinstance(dataset, TabularBenchmarkDataset):
        dates = [str(v)[:10] for v in dataset.dates.tolist()] if len(dataset.dates) else []
        return {
            "status": "available",
            "source": dataset.source,
            "rows": int(len(dataset.y)),
            "features": int(dataset.X.shape[1]) if dataset.X.ndim == 2 else 0,
            "start_date": start_date or (min(dates) if dates else None),
            "end_date": end_date or (max(dates) if dates else None),
            "market_lanes": sorted({str(v) for v in dataset.sectors.tolist()})[:20],
        }
    lengths = [len(row.get("close") or []) for row in dataset.records]
    return {
        "status": "available",
        "source": dataset.source,
        "symbols": int(len(dataset.records)),
        "rows": int(sum(lengths)),
        "min_series_len": int(min(lengths)) if lengths else 0,
        "max_series_len": int(max(lengths)) if lengths else 0,
        "start_date": start_date,
        "end_date": end_date,
    }


def _bucket():
    from app.model_store import _get_bucket

    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not configured")
    return bucket


def _load_npz_bytes(raw: bytes):
    buf = io.BytesIO(raw)
    return np.load(buf, allow_pickle=True)


def load_tabular_dataset(payload: dict[str, Any]) -> TabularBenchmarkDataset:
    data = payload.get("tabular_dataset")
    if isinstance(data, dict) and "X" in data and "y" in data:
        X = np.asarray(data["X"], dtype=np.float32)
        y = np.asarray(data["y"], dtype=np.float32).reshape(-1)
        dates = np.asarray(data.get("dates", np.arange(len(y))), dtype=object)
        sectors = np.asarray(data.get("sectors", ["unknown"] * len(y)), dtype=object)
        names = [str(v) for v in data.get("feature_names", [])] or [f"f{i}" for i in range(X.shape[1])]
        return TabularBenchmarkDataset(X=X, y=y, dates=dates, sectors=sectors, feature_names=names, source="payload.tabular_dataset")

    gcs_prefix = str(payload.get("gcs_prefix") or payload.get("data_slice", {}).get("gcs_prefix") or "universal").strip().rstrip("/")
    batch_count = int(payload.get("batch_count") or payload.get("data_slice", {}).get("batch_count") or 5)
    bucket = _bucket()
    keys = [f"{gcs_prefix}/prep/batch_{i}.npz" for i in range(batch_count)]
    from app.gcs_batch_io import download_existing_blobs

    all_X: list[np.ndarray] = []
    all_y: list[np.ndarray] = []
    all_dates: list[np.ndarray] = []
    all_sectors: list[np.ndarray] = []
    for _, raw in download_existing_blobs(bucket, keys, max_workers=4):
        if raw is None:
            continue
        npz = _load_npz_bytes(raw)
        if "X" not in npz.files or "y" not in npz.files:
            continue
        all_X.append(np.asarray(npz["X"], dtype=np.float32))
        all_y.append(np.asarray(npz["y"], dtype=np.float32).reshape(-1))
        all_dates.append(np.asarray(npz["dates"] if "dates" in npz.files else np.arange(len(all_y[-1])), dtype=object))
        all_sectors.append(np.asarray(npz["sectors"] if "sectors" in npz.files else ["unknown"] * len(all_y[-1]), dtype=object))
    if not all_X:
        raise RuntimeError(f"no tabular prep batches found under {gcs_prefix}/prep")

    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    dates = np.concatenate(all_dates)
    sectors = np.concatenate(all_sectors)
    feature_blob = bucket.blob(f"{gcs_prefix}/prep/feature_names.json")
    if feature_blob.exists():
        import json

        feature_names = [str(v) for v in json.loads(feature_blob.download_as_text())]
    else:
        feature_names = [f"f{i}" for i in range(X.shape[1])]
    order = np.argsort(dates.astype(str))
    return TabularBenchmarkDataset(
        X=X[order],
        y=y[order],
        dates=dates[order],
        sectors=sectors[order],
        feature_names=feature_names,
        source=f"gs://*/{gcs_prefix}/prep/*.npz",
    )


def load_sequence_dataset(payload: dict[str, Any]) -> SequenceBenchmarkDataset:
    records = payload.get("sequence_records")
    if isinstance(records, list) and records:
        return SequenceBenchmarkDataset(records=[row for row in records if isinstance(row, dict)], source="payload.sequence_records")

    data_slice = payload.get("data_slice", {}) if isinstance(payload.get("data_slice"), dict) else {}
    gcs_prefix = str(
        payload.get("sequence_gcs_prefix")
        or data_slice.get("sequence_gcs_prefix")
        or payload.get("gcs_prefix")
        or data_slice.get("gcs_prefix")
        or "universal"
    ).strip().rstrip("/")
    batch_count = int(
        payload.get("sequence_batch_count")
        or data_slice.get("sequence_batch_count")
        or payload.get("batch_count")
        or data_slice.get("batch_count")
        or 5
    )
    bucket = _bucket()
    keys = [f"{gcs_prefix}/prep/batch_{i}.npz" for i in range(batch_count)]
    from app.gcs_batch_io import download_existing_blobs

    loaded: list[dict[str, Any]] = []
    for key, raw in download_existing_blobs(bucket, keys, max_workers=4):
        if raw is None:
            continue
        npz = _load_npz_bytes(raw)
        if "sequence_records" in npz.files:
            for row in npz["sequence_records"].tolist():
                if isinstance(row, dict) and row.get("close"):
                    loaded.append(row)
            continue
        if "series_close" in npz.files:
            for idx, close in enumerate(npz["series_close"].tolist()):
                if close:
                    loaded.append({"symbol": f"legacy_{key}_{idx}", "close": close, "dates": []})
    if not loaded:
        raise RuntimeError(f"no sequence prep batches found under {gcs_prefix}/prep")
    return SequenceBenchmarkDataset(records=loaded, source=f"gs://*/{gcs_prefix}/prep/*.npz")
