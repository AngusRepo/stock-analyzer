"""NeuralForecast-backed sequence artifact runtime for PatchTST/iTransformer."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import shutil
import tempfile
import time
import warnings
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from .model_store import _get_bucket
from .prep_lineage import (
    attach_prep_lineage_aliases,
    collect_prep_lineage,
    validate_prep_lineage_for_registration,
)
from .research_benchmarks.common import cpcv_proxy_pbo, data_slice_report, direction_accuracy, load_sequence_dataset, rank_ic
from .sequence_training import build_sequence_window_dataset
from .model_validation import build_model_cpcv_evidence

logger = logging.getLogger(__name__)

DEFAULT_SEQ_LEN = 512
DEFAULT_PRED_LEN = 5
DEFAULT_MAX_STEPS = 30
DEFAULT_BATCH_SIZE = 128
DEFAULT_MAX_SERIES = 1024
DEFAULT_BATCH_COUNT = 5
_RUNTIME_CONFIGURED = False
MODEL_CONFIG: dict[str, dict[str, str]] = {
    "PatchTST": {
        "nf_model_name": "PatchTST",
        "gcs_prefix": "universal/patchtst",
        "artifact_schema": "neuralforecast_patchtst_universal_v1",
        "model_type": "time_series_transformer_neuralforecast_patchtst",
        "default_seq_len": "512",
    },
    "iTransformer": {
        "nf_model_name": "iTransformer",
        "gcs_prefix": "universal/itransformer",
        "artifact_schema": "neuralforecast_itransformer_universal_v1",
        "model_type": "time_series_transformer_neuralforecast_itransformer",
        "default_seq_len": "1024",
    },
}


def _utc_version() -> str:
    return "v" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")


def _require_model(model_name: str) -> dict[str, str]:
    if model_name not in MODEL_CONFIG:
        raise ValueError(f"unsupported NeuralForecast sequence model: {model_name}")
    return MODEL_CONFIG[model_name]


def default_seq_len_for_model(model_name: str) -> int:
    return int(_require_model(model_name).get("default_seq_len") or DEFAULT_SEQ_LEN)


def _configure_neuralforecast_runtime() -> None:
    global _RUNTIME_CONFIGURED
    if not _RUNTIME_CONFIGURED:
        warnings.filterwarnings(
            "ignore",
            message=r".*isinstance\(treespec, LeafSpec\).*",
            category=UserWarning,
            module=r"pytorch_lightning\.utilities\._pytree",
        )
        logging.getLogger("pytorch_lightning").setLevel(logging.WARNING)
        logging.getLogger("lightning.pytorch").setLevel(logging.WARNING)
        _RUNTIME_CONFIGURED = True
    try:
        import torch

        if torch.cuda.is_available():
            precision = os.environ.get("TORCH_FLOAT32_MATMUL_PRECISION", "high").strip() or "high"
            torch.set_float32_matmul_precision(precision)
    except Exception as exc:  # noqa: BLE001 - runtime tuning must never block training.
        logger.debug("NeuralForecast torch runtime tuning skipped: %s", exc)


def _coerce_close(row: dict[str, Any]) -> list[float]:
    close: list[float] = []
    for value in row.get("close") or row.get("series_close") or row.get("prices") or []:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if np.isfinite(parsed):
            close.append(parsed)
    return close


def _panel_train_eval_rows(
    records: list[dict[str, Any]],
    *,
    seq_len: int,
    pred_len: int,
    max_series: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    train_rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    min_history = int(seq_len) + int(pred_len)
    skipped_short_history = 0
    considered = 0
    for record in records:
        considered += 1
        if len(eval_rows) >= max(1, max_series):
            break
        close = _coerce_close(record)
        if len(close) < min_history:
            skipped_short_history += 1
            continue
        symbol = str(record.get("symbol") or f"series_{len(eval_rows)}")
        train_close = close[:-pred_len]
        actual_close = close[-pred_len:]
        if not train_close or not actual_close:
            continue
        for ds_idx, y_value in enumerate(train_close):
            train_rows.append({"unique_id": symbol, "ds": int(ds_idx), "y": float(y_value)})
        eval_rows.append({
            "unique_id": symbol,
            "last_close": float(train_close[-1]),
            "actual_last": float(actual_close[-1]),
            "history_len": int(len(close)),
        })
    return train_rows, eval_rows, {
        "considered_series": int(considered),
        "valid_series": int(len(eval_rows)),
        "skipped_short_history": int(skipped_short_history),
        "min_history": int(min_history),
        "seq_len": int(seq_len),
        "pred_len": int(pred_len),
        "max_series": int(max_series),
    }


def _series_list_to_df_rows(series_list: list[dict[str, Any]], *, seq_len: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    for idx, item in enumerate(series_list or []):
        close = _coerce_close(item)
        symbol = str(item.get("symbol") or f"series_{idx}")
        if len(close) < seq_len:
            eval_rows.append({"unique_id": symbol, "error": f"insufficient data ({len(close)} < {seq_len})"})
            continue
        window = close[-seq_len:]
        for ds_idx, y_value in enumerate(window):
            rows.append({"unique_id": symbol, "ds": int(ds_idx), "y": float(y_value)})
        eval_rows.append({
            "unique_id": symbol,
            "symbol": symbol,
            "last_close": float(window[-1]),
            "n_used": int(seq_len),
        })
    return rows, eval_rows


def _fold_metrics(candidate_id: str, pred_return: np.ndarray, actual_return: np.ndarray) -> list[dict[str, Any]]:
    pred_return = np.asarray(pred_return, dtype=float).reshape(-1)
    actual_return = np.asarray(actual_return, dtype=float).reshape(-1)
    fold_count = min(5, max(1, len(actual_return) // 30))
    metrics: list[dict[str, Any]] = []
    for fold_id, idx in enumerate(np.array_split(np.arange(len(actual_return)), fold_count)):
        if len(idx) < 2:
            continue
        metrics.append({
            "fold_id": f"{candidate_id}_oos_{fold_id}",
            "oos_ic": rank_ic(pred_return[idx], actual_return[idx]),
            "direction_accuracy": direction_accuracy(pred_return[idx], actual_return[idx]),
            "test_rows": int(len(idx)),
            "coverage": float(len(idx) / max(1, len(actual_return))),
        })
    if metrics:
        return metrics
    return [{
        "fold_id": f"{candidate_id}_oos_holdout",
        "oos_ic": rank_ic(pred_return, actual_return),
        "direction_accuracy": direction_accuracy(pred_return, actual_return),
        "test_rows": int(len(actual_return)),
        "coverage": 1.0 if len(actual_return) else 0.0,
    }]


def _make_nf_model(model_name: str, *, pred_len: int, seq_len: int, max_steps: int, batch_size: int, seed: int, n_series: int):
    _configure_neuralforecast_runtime()
    from neuralforecast.models import PatchTST, iTransformer

    val_check_steps = max(1, min(int(max_steps), 10))
    common = {
        "h": pred_len,
        "input_size": seq_len,
        "max_steps": max_steps,
        "val_check_steps": val_check_steps,
        "batch_size": batch_size,
        "random_seed": seed,
        "enable_checkpointing": False,
        "enable_model_summary": False,
        "enable_progress_bar": False,
        "logger": False,
    }
    if model_name == "PatchTST":
        return PatchTST(**common)
    if model_name == "iTransformer":
        return iTransformer(n_series=max(1, n_series), **common)
    raise ValueError(f"unsupported NeuralForecast model: {model_name}")


def _train_nf(
    train_rows: list[dict[str, Any]],
    *,
    model_name: str,
    pred_len: int,
    seq_len: int,
    max_steps: int,
    batch_size: int,
    seed: int,
    n_series: int,
):
    _configure_neuralforecast_runtime()
    import pandas as pd
    from neuralforecast import NeuralForecast

    df = pd.DataFrame(train_rows)
    model = _make_nf_model(
        model_name,
        pred_len=pred_len,
        seq_len=seq_len,
        max_steps=max_steps,
        batch_size=batch_size,
        seed=seed,
        n_series=n_series,
    )
    nf = NeuralForecast(models=[model], freq=1)
    nf.fit(df=df)
    return nf, df


def _predict_horizon_by_id(nf: Any, df: Any, *, horizon_idx: int) -> dict[str, float]:
    pred_df = nf.predict(df=df).reset_index()
    numeric_cols = [col for col in pred_df.columns if col not in {"unique_id", "ds"}]
    if not numeric_cols:
        raise RuntimeError("NeuralForecast prediction column missing")
    pred_col = numeric_cols[0]
    pred_by_id: dict[str, float] = {}
    for uid, group in pred_df.sort_values(["unique_id", "ds"]).groupby("unique_id", sort=False):
        idx = min(max(int(horizon_idx), 1), len(group)) - 1
        pred_by_id[str(uid)] = float(group.iloc[idx][pred_col])
    return pred_by_id


def _zip_dir(path: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in path.rglob("*"):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(path).as_posix())
    return buf.getvalue()


def _unzip_bytes(raw: bytes, path: Path) -> None:
    with zipfile.ZipFile(io.BytesIO(raw), "r") as zf:
        zf.extractall(path)


def _save_nf_artifact(bucket: Any, nf: Any, *, model_name: str, version: str, metadata: dict[str, Any]) -> dict[str, Any]:
    cfg = _require_model(model_name)
    with tempfile.TemporaryDirectory(prefix=f"nf_{model_name.lower()}_") as tmp:
        model_dir = Path(tmp) / "model"
        nf.save(path=str(model_dir), overwrite=True, save_dataset=False)
        raw = _zip_dir(model_dir)
    artifact_path = f"{cfg['gcs_prefix']}/{version}.zip"
    metadata_path = f"{cfg['gcs_prefix']}/metadata_{version}.json"
    checksum = "sha256:" + hashlib.sha256(raw).hexdigest()
    bucket.blob(artifact_path).upload_from_string(raw, content_type="application/zip")
    payload = {
        **metadata,
        "checksum": checksum,
        "artifact_path": artifact_path,
        "metadata_path": metadata_path,
    }
    bucket.blob(metadata_path).upload_from_string(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        content_type="application/json",
    )
    return {"artifact_path": artifact_path, "metadata_path": metadata_path, "checksum": checksum, "metadata": payload}


_MODEL_CACHE: dict[str, dict[str, Any]] = {}


def load_neuralforecast_artifact(model_name: str, version: str = "v1") -> tuple[Any | None, dict[str, Any] | None]:
    _configure_neuralforecast_runtime()
    from neuralforecast import NeuralForecast

    cfg = _require_model(model_name)
    cache_key = f"{model_name}:{version}"
    if cache_key in _MODEL_CACHE:
        cached = _MODEL_CACHE[cache_key]
        return cached["model"], cached["metadata"]
    try:
        bucket = _get_bucket()
        if bucket is None:
            raise RuntimeError("GCS bucket not available")
        artifact_blob = bucket.blob(f"{cfg['gcs_prefix']}/{version}.zip")
        meta_blob = bucket.blob(f"{cfg['gcs_prefix']}/metadata_{version}.json")
        if not artifact_blob.exists():
            return None, None
        metadata = json.loads(meta_blob.download_as_text()) if meta_blob.exists() else {}
        tmp = Path(tempfile.mkdtemp(prefix=f"nf_load_{model_name.lower()}_"))
        _unzip_bytes(artifact_blob.download_as_bytes(), tmp)
        nf = NeuralForecast.load(path=str(tmp))
        _MODEL_CACHE[cache_key] = {"model": nf, "metadata": metadata, "tmp_dir": str(tmp)}
        return nf, metadata
    except Exception as exc:  # noqa: BLE001
        logger.warning("[%s NeuralForecast] load failed: %s", model_name, exc)
        return None, None


def clear_neuralforecast_cache() -> None:
    for cached in _MODEL_CACHE.values():
        tmp_dir = cached.get("tmp_dir")
        if tmp_dir:
            shutil.rmtree(str(tmp_dir), ignore_errors=True)
    _MODEL_CACHE.clear()


def neuralforecast_batch_predict(
    *,
    model_name: str,
    series_list: list[dict[str, Any]],
    horizon_used: int = DEFAULT_PRED_LEN,
    version: str = "v1",
) -> list[dict[str, Any]]:
    nf, metadata = load_neuralforecast_artifact(model_name, version)
    cfg = _require_model(model_name)
    if nf is None:
        return [
            {
                "symbol": row.get("symbol", "?"),
                "error": f"{model_name} NeuralForecast artifact not in GCS at {cfg['gcs_prefix']}/{version}.zip",
            }
            for row in series_list
        ]

    import pandas as pd

    seq_len = int((metadata or {}).get("seq_len") or DEFAULT_SEQ_LEN)
    pred_len = int((metadata or {}).get("pred_len") or DEFAULT_PRED_LEN)
    rows, eval_rows = _series_list_to_df_rows(series_list, seq_len=seq_len)
    out_by_uid: dict[str, dict[str, Any]] = {
        str(row["unique_id"]): {"symbol": row.get("unique_id", "?"), "error": row["error"]}
        for row in eval_rows
        if row.get("error")
    }
    valid_eval = [row for row in eval_rows if not row.get("error")]
    if rows and valid_eval:
        h_idx = min(max(int(horizon_used), 1), pred_len)
        try:
            pred_by_id = _predict_horizon_by_id(nf, pd.DataFrame(rows), horizon_idx=h_idx)
        except Exception as exc:  # noqa: BLE001
            return [
                {"symbol": item.get("symbol", "?"), "error": f"{model_name} NeuralForecast inference failed: {type(exc).__name__}: {exc}"}
                for item in series_list
            ]
        for row in valid_eval:
            uid = str(row["unique_id"])
            if uid not in pred_by_id:
                out_by_uid[uid] = {"symbol": row.get("symbol", uid), "error": f"{model_name} prediction missing"}
                continue
            last_close = float(row["last_close"])
            forecast_price = float(pred_by_id[uid])
            forecast_pct = (forecast_price - last_close) / max(last_close, 1e-9)
            out_by_uid[uid] = {
                "symbol": row.get("symbol", uid),
                "model": model_name,
                "forecast_pct": round(float(forecast_pct), 4),
                "forecast_price": round(float(forecast_price), 4),
                "direction": "up" if forecast_pct > 0 else "down",
                "confidence": round(min(0.85, max(0.35, 0.5 + min(0.35, abs(forecast_pct) * 8))), 3),
                "n_used": int(row.get("n_used") or seq_len),
                "model_version": version,
                "artifact_schema": cfg["artifact_schema"],
                "horizon_used": h_idx,
            }
    return [
        out_by_uid.get(str(item.get("symbol") or f"series_{idx}"), {"symbol": item.get("symbol", "?"), "error": "prediction missing"})
        for idx, item in enumerate(series_list or [])
    ]


def train_neuralforecast_sequence_artifact(payload: dict[str, Any], *, model_name: str) -> dict[str, Any]:
    started_at = time.time()
    cfg = _require_model(model_name)
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    version = str(payload.get("output_model_version") or payload.get("version") or _utc_version())
    seq_len = int(payload.get("seq_len") or payload.get("data_slice", {}).get("seq_len") or default_seq_len_for_model(model_name))
    pred_len = int(payload.get("pred_len") or payload.get("data_slice", {}).get("pred_len") or DEFAULT_PRED_LEN)
    max_steps = int(payload.get("max_steps") or payload.get("n_epochs") or payload.get("epochs") or DEFAULT_MAX_STEPS)
    batch_size = int(payload.get("batch_size") or DEFAULT_BATCH_SIZE)
    seed = int(payload.get("seed") or 42)
    max_series = int(payload.get("max_series") or payload.get("data_slice", {}).get("max_series") or DEFAULT_MAX_SERIES)
    gcs_prefix = str(payload.get("gcs_prefix") or payload.get("data_slice", {}).get("gcs_prefix") or "universal").strip().rstrip("/")
    sequence_gcs_prefix = str(
        payload.get("sequence_gcs_prefix")
        or payload.get("data_slice", {}).get("sequence_gcs_prefix")
        or gcs_prefix
    ).strip().rstrip("/")
    sequence_batch_count = int(
        payload.get("sequence_batch_count")
        or payload.get("data_slice", {}).get("sequence_batch_count")
        or payload.get("batch_count")
        or DEFAULT_BATCH_COUNT
    )
    promote_to_active = bool(payload.get("promote_to_active", False))
    payload.setdefault("batch_count", int(payload.get("batch_count") or DEFAULT_BATCH_COUNT))

    dataset_source = load_sequence_dataset(payload)
    train_rows, eval_rows, series_filter = _panel_train_eval_rows(
        dataset_source.records,
        seq_len=seq_len,
        pred_len=pred_len,
        max_series=max_series,
    )
    if len(eval_rows) < 10:
        raise ValueError(
            f"{model_name} NeuralForecast training requires >=10 valid series, got {len(eval_rows)} "
            f"(min_history={series_filter['min_history']}, "
            f"skipped_short_history={series_filter['skipped_short_history']}, "
            f"considered_series={series_filter['considered_series']})"
        )
    nf, df = _train_nf(
        train_rows,
        model_name=cfg["nf_model_name"],
        pred_len=pred_len,
        seq_len=seq_len,
        max_steps=max_steps,
        batch_size=batch_size,
        seed=seed,
        n_series=len(eval_rows),
    )
    pred_by_id = _predict_horizon_by_id(nf, df, horizon_idx=pred_len)
    pred_return: list[float] = []
    actual_return: list[float] = []
    for row in eval_rows:
        uid = str(row["unique_id"])
        if uid not in pred_by_id:
            continue
        last_close = float(row["last_close"])
        pred_return.append((float(pred_by_id[uid]) - last_close) / max(last_close, 1e-9))
        actual_return.append((float(row["actual_last"]) - last_close) / max(last_close, 1e-9))
    folds = _fold_metrics(model_name, np.asarray(pred_return, dtype=float), np.asarray(actual_return, dtype=float))
    model_cpcv = build_model_cpcv_evidence(
        model=model_name,
        fold_metrics=folds,
        policy=payload.get("model_cpcv_policy") or None,
        family="learned_sequence",
        coverage_mode="sequence_window",
    )
    oos_ic = rank_ic(np.asarray(pred_return, dtype=float), np.asarray(actual_return, dtype=float))
    metrics = {
        "oos_ic": round(float(oos_ic), 6),
        "direction_accuracy": round(float(direction_accuracy(np.asarray(pred_return), np.asarray(actual_return))), 6),
        "rank_ic_all": round(float(oos_ic), 6),
        "pbo": cpcv_proxy_pbo(folds),
        "oos_samples": int(len(pred_return)),
        "fold_metrics": folds,
        "model_cpcv_decision": model_cpcv.get("decision"),
    }

    lineage_dates = []
    for row in dataset_source.records[:max_series]:
        dates = row.get("dates") or []
        if dates:
            lineage_dates.extend(str(v) for v in dates[-pred_len:])
    prep_lineage = collect_prep_lineage(
        bucket,
        gcs_prefix=sequence_gcs_prefix,
        batch_count=sequence_batch_count,
        feature_names=["close"],
        rows=len(train_rows),
        dates=lineage_dates,
    )
    prep_freshness = (
        validate_prep_lineage_for_registration(
            prep_lineage,
            as_of_date=payload.get("as_of_date") or payload.get("run_date"),
            max_stale_days=payload.get("max_prep_stale_days"),
            label_horizon_days=payload.get("label_horizon_days"),
        )
        if promote_to_active
        and dataset_source.source.startswith("gs://")
        and gcs_prefix == "universal"
        and payload.get("disable_stale_prep_guard") is not True
        else {"status": "skipped"}
    )
    trained_at = datetime.now(timezone.utc).isoformat()
    metadata = attach_prep_lineage_aliases({
        "schema_version": f"{cfg['artifact_schema']}_metadata_v1",
        "artifact_schema": cfg["artifact_schema"],
        "version": version,
        "model_name": model_name,
        "model_type": cfg["model_type"],
        "family": "time_series",
        "runtime_package": "neuralforecast",
        "trained_at": trained_at,
        "feature_names": ["close"],
        "feature_count": 1,
        "seq_len": seq_len,
        "pred_len": pred_len,
        "max_steps": max_steps,
        "batch_size": batch_size,
        "seed": seed,
        "metrics": metrics,
        "model_cpcv": model_cpcv,
        "oos_ic": metrics["oos_ic"],
        "direction_accuracy": metrics["direction_accuracy"],
        "sample_count": int(len(train_rows)),
        "validation_sample_count": int(len(pred_return)),
        "dataset_snapshot": {
            "source": dataset_source.source,
            "gcs_prefix": gcs_prefix,
            "sequence_gcs_prefix": sequence_gcs_prefix,
            "batch_count": sequence_batch_count,
            "max_series": max_series,
            "series_filter": series_filter,
            "data_slice_report": data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
            "prep_lineage": prep_lineage,
            "prep_freshness": prep_freshness,
        },
        "feature_policy": {
            "model": model_name,
            "family": "time_series",
            "feature_policy_type": "sequence_artifact_required",
            "feature_source": "universal/prep sequence_records",
            "selection_method": "production_artifact",
        },
    }, prep_lineage)
    saved = _save_nf_artifact(bucket, nf, model_name=model_name, version=version, metadata=metadata)
    return {
        "status": "ok",
        "model": model_name,
        "version": version,
        "artifact_path": saved["artifact_path"],
        "metadata_path": saved["metadata_path"],
        "checksum": saved["checksum"],
        "metadata": saved["metadata"],
        "metrics": metrics,
        "model_cpcv": model_cpcv,
        "ic_tracking": {
            model_name: {
                "oos_ic": metrics["oos_ic"],
                "oos_samples": metrics["oos_samples"],
                "pbo": metrics["pbo"],
                "passed": float(metrics["oos_ic"] or 0.0) > 0.0,
                "source": "neuralforecast_sequence_oos",
                "model_cpcv": model_cpcv,
            },
        },
        "oos_ic": metrics["oos_ic"],
        "train_samples": int(len(train_rows)),
        "validation_samples": int(len(pred_return)),
        "elapsed_s": round(time.time() - started_at, 3),
    }
