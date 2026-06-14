from __future__ import annotations

import time
from typing import Any

import numpy as np

from app.sequence_training import build_sequence_window_dataset

from .common import (
    cost_sensitivity,
    cpcv_proxy_pbo,
    data_slice_report,
    direction_accuracy,
    load_sequence_dataset,
    rank_ic,
)


_MODEL_CACHE: dict[str, Any] = {}


def _blocked(candidate_id: str, blocker: str, dataset_source: Any | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "blocked",
        "candidate_id": candidate_id,
        "blockers": [blocker],
    }
    if dataset_source is not None:
        payload = payload or {}
        result["data_slice_report"] = data_slice_report(
            dataset=dataset_source,
            start_date=payload.get("start_date"),
            end_date=payload.get("end_date"),
        )
    return result


def _load_timesfm_model(payload: dict[str, Any]):
    import timesfm

    model_id = str(payload.get("model_id") or payload.get("data_slice", {}).get("model_id") or "google/timesfm-2.0-500m-pytorch")
    max_context = int(payload.get("max_context") or 1024)
    max_horizon = int(payload.get("max_horizon") or 256)
    cache_key = f"{model_id}:{max_context}:{max_horizon}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    if "2.5" in model_id or "2p5" in model_id:
        if not hasattr(timesfm, "TimesFM_2p5_200M_torch"):
            raise RuntimeError("timesfm package does not expose TimesFM_2p5_200M_torch")
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
        try:
            import torch
            backend = "gpu" if torch.cuda.is_available() else "cpu"
        except Exception:  # noqa: BLE001
            backend = "cpu"
        model = timesfm.TimesFm(
            hparams=timesfm.TimesFmHparams(
                backend=backend,
                per_core_batch_size=32,
                horizon_len=max_horizon,
                num_layers=50,
                use_positional_embedding=False,
                context_len=min(max_context, 2048),
            ),
            checkpoint=timesfm.TimesFmCheckpoint(huggingface_repo_id=model_id),
        )
        _MODEL_CACHE[cache_key] = model
        return model

    raise RuntimeError("timesfm package exposes neither TimesFM_2p5_200M_torch nor TimesFm")


def _forecast_timesfm(model, *, horizon: int, inputs: list[np.ndarray]):
    try:
        return model.forecast(horizon=horizon, inputs=inputs)
    except TypeError:
        freq = [0] * len(inputs)
        return model.forecast(inputs, freq=freq)


def run_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = time.time()
    candidate_id = str(payload.get("candidate_id") or "TimesFM")
    seq_len = int(payload.get("seq_len") or payload.get("data_slice", {}).get("seq_len") or 60)
    pred_len = int(payload.get("pred_len") or payload.get("data_slice", {}).get("pred_len") or 5)
    dataset_source = load_sequence_dataset(payload)
    window_dataset = build_sequence_window_dataset(
        dataset_source.records,
        seq_len=seq_len,
        pred_len=pred_len,
        oos_ratio=float(payload.get("oos_ratio") or 0.2),
    )
    if not window_dataset.report.get("lifecycle_ready"):
        return _blocked(candidate_id, "sequence_dataset_not_lifecycle_ready", dataset_source, payload)

    max_oos = int(payload.get("max_oos_windows") or payload.get("data_slice", {}).get("max_oos_windows") or 512)
    oos_take = np.arange(len(window_dataset.X_oos))
    if len(oos_take) > max_oos:
        oos_take = np.linspace(0, len(oos_take) - 1, max_oos).astype(int)
    available_oos_windows = int(len(window_dataset.X_oos))
    sampled_oos_windows = int(len(oos_take))
    dataset_coverage = float(sampled_oos_windows / max(1, available_oos_windows))

    try:
        model = _load_timesfm_model(payload)
    except Exception as exc:  # noqa: BLE001
        return _blocked(candidate_id, f"timesfm_model_load_error:{type(exc).__name__}:{exc}", dataset_source, payload)
    inputs = [np.asarray(row, dtype=np.float32) for row in window_dataset.X_oos[oos_take]]
    try:
        point_forecast, _quantiles = _forecast_timesfm(model, horizon=pred_len, inputs=inputs)
    except Exception as exc:  # noqa: BLE001
        return _blocked(candidate_id, f"timesfm_forecast_error:{type(exc).__name__}:{exc}", dataset_source, payload)
    forecast_last = np.asarray(point_forecast, dtype=float)[:, -1]
    actual_last = window_dataset.y_oos[oos_take, -1]
    selected_oos_index = window_dataset.oos_index[oos_take]
    last_close = np.asarray([window_dataset.meta[int(idx)]["last_close"] for idx in selected_oos_index], dtype=float)
    pred_return = (forecast_last - last_close) / np.maximum(last_close, 1e-9)
    actual_return = (actual_last - last_close) / np.maximum(last_close, 1e-9)
    fold_metrics: list[dict[str, Any]] = []
    for fold_id, idx in enumerate(np.array_split(np.arange(len(actual_return)), min(5, max(1, len(actual_return) // 30)))):
        if len(idx) < 2:
            continue
        fold_share = float(len(idx) / max(1, sampled_oos_windows))
        fold_metrics.append({
            "fold_id": f"timesfm_oos_{fold_id}",
            "oos_ic": rank_ic(pred_return[idx], actual_return[idx]),
            "direction_accuracy": direction_accuracy(pred_return[idx], actual_return[idx]),
            "test_rows": int(len(idx)),
            "coverage": 1.0,
            "sampled_coverage": 1.0,
            "dataset_coverage": dataset_coverage,
            "fold_share": fold_share,
        })
    if not fold_metrics:
        fold_metrics = [{
            "fold_id": "timesfm_oos_holdout",
            "oos_ic": rank_ic(pred_return, actual_return),
            "direction_accuracy": direction_accuracy(pred_return, actual_return),
            "test_rows": int(len(actual_return)),
            "coverage": 1.0 if len(actual_return) else 0.0,
            "sampled_coverage": 1.0 if len(actual_return) else 0.0,
            "dataset_coverage": dataset_coverage,
            "fold_share": 1.0 if len(actual_return) else 0.0,
        }]
    return {
        "status": "available",
        "candidate_id": candidate_id,
        "fold_metrics": fold_metrics,
        "pbo": cpcv_proxy_pbo(fold_metrics),
        "cost_sensitivity": cost_sensitivity(started_at, gpu="torch_runtime", rows=int(window_dataset.report.get("windows", 0)), folds=len(fold_metrics)),
        "data_slice_report": {
            **data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
            "sequence_report": window_dataset.report,
            "model_id": str(payload.get("model_id") or payload.get("data_slice", {}).get("model_id") or "google/timesfm-2.0-500m-pytorch"),
            "max_oos_windows": max_oos,
            "available_oos_windows": available_oos_windows,
            "sampled_oos_windows": sampled_oos_windows,
            "dataset_coverage": dataset_coverage,
            "coverage_mode": "sample_complete",
        },
        "coverage_mode": "sample_complete",
    }
