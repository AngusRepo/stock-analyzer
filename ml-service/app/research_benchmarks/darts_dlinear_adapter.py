from __future__ import annotations

import time
from typing import Any

import numpy as np

from app.sequence_training import build_sequence_window_dataset

from .common import cost_sensitivity, cpcv_proxy_pbo, data_slice_report, direction_accuracy, load_sequence_dataset, rank_ic


def _blocked(candidate_id: str, blocker: str, dataset_source: Any | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "blocked", "candidate_id": candidate_id, "blockers": [blocker]}
    if dataset_source is not None:
        payload = payload or {}
        result["data_slice_report"] = data_slice_report(
            dataset=dataset_source,
            start_date=payload.get("start_date"),
            end_date=payload.get("end_date"),
        )
    return result


def _window_series(values: np.ndarray, *, limit: int | None = None) -> list[Any]:
    from darts import TimeSeries

    rows = np.asarray(values, dtype=np.float32)
    if limit is not None and len(rows) > limit:
        take = np.linspace(0, len(rows) - 1, int(limit)).astype(int)
        rows = rows[take]
    return [TimeSeries.from_values(row.reshape(-1, 1)) for row in rows]


def run_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = time.time()
    candidate_id = "DartsDLinear"
    try:
        from darts.models import DLinearModel
    except Exception as exc:  # noqa: BLE001
        return _blocked(candidate_id, f"missing_darts_runtime:{type(exc).__name__}:{exc}")

    seq_len = int(payload.get("seq_len") or payload.get("data_slice", {}).get("seq_len") or 60)
    pred_len = int(payload.get("pred_len") or payload.get("data_slice", {}).get("pred_len") or 5)
    dataset_source = load_sequence_dataset(payload)
    window_dataset = build_sequence_window_dataset(
        dataset_source.records,
        seq_len=seq_len,
        pred_len=pred_len,
        oos_ratio=float(payload.get("oos_ratio") or payload.get("data_slice", {}).get("oos_ratio") or 0.2),
    )
    if not window_dataset.report.get("lifecycle_ready"):
        return _blocked(candidate_id, "sequence_dataset_not_lifecycle_ready", dataset_source, payload)

    max_windows = int(payload.get("max_windows") or payload.get("data_slice", {}).get("max_windows") or 8000)
    max_oos = int(payload.get("max_oos_windows") or payload.get("data_slice", {}).get("max_oos_windows") or 512)
    train_values = np.concatenate([window_dataset.X_train, window_dataset.y_train], axis=1)
    train_series = _window_series(train_values, limit=max_windows)
    oos_take = np.arange(len(window_dataset.X_oos))
    if len(oos_take) > max_oos:
        oos_take = np.linspace(0, len(oos_take) - 1, max_oos).astype(int)
    oos_series = _window_series(window_dataset.X_oos[oos_take], limit=None)

    try:
        model = DLinearModel(
            input_chunk_length=seq_len,
            output_chunk_length=pred_len,
            n_epochs=int(payload.get("epochs") or payload.get("data_slice", {}).get("epochs") or 5),
            batch_size=int(payload.get("batch_size") or payload.get("data_slice", {}).get("batch_size") or 128),
            random_state=int(payload.get("seed") or payload.get("data_slice", {}).get("seed") or 42),
            force_reset=True,
            save_checkpoints=False,
            log_tensorboard=False,
            pl_trainer_kwargs={
                "enable_checkpointing": False,
                "enable_model_summary": False,
                "logger": False,
            },
        )
        model.fit(series=train_series, verbose=False)
        forecasts = model.predict(n=pred_len, series=oos_series, verbose=False)
    except Exception as exc:  # noqa: BLE001
        return _blocked(candidate_id, f"darts_dlinear_runtime_error:{type(exc).__name__}:{exc}", dataset_source, payload)

    forecast_last = np.asarray([float(ts.values(copy=False)[-1, 0]) for ts in forecasts], dtype=float)
    actual_last = window_dataset.y_oos[oos_take, -1]
    selected_oos_index = window_dataset.oos_index[oos_take]
    last_close = np.asarray([window_dataset.meta[int(idx)]["last_close"] for idx in selected_oos_index], dtype=float)
    pred_return = (forecast_last - last_close) / np.maximum(last_close, 1e-9)
    actual_return = (actual_last - last_close) / np.maximum(last_close, 1e-9)

    fold_metrics: list[dict[str, Any]] = []
    for fold_id, idx in enumerate(np.array_split(np.arange(len(actual_return)), min(5, max(1, len(actual_return) // 30)))):
        if len(idx) < 2:
            continue
        fold_metrics.append({
            "fold_id": f"darts_dlinear_oos_{fold_id}",
            "oos_ic": rank_ic(pred_return[idx], actual_return[idx]),
            "direction_accuracy": direction_accuracy(pred_return[idx], actual_return[idx]),
            "test_rows": int(len(idx)),
            "coverage": float(len(idx) / max(1, len(window_dataset.X_oos))),
        })
    return {
        "status": "available",
        "candidate_id": candidate_id,
        "fold_metrics": fold_metrics,
        "pbo": cpcv_proxy_pbo(fold_metrics),
        "cost_sensitivity": cost_sensitivity(started_at, gpu=None, rows=int(window_dataset.report.get("windows", 0)), folds=len(fold_metrics)),
        "data_slice_report": {
            **data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
            "sequence_report": window_dataset.report,
            "adapter_note": "Darts DLinearModel read-only sliding-window benchmark; no GCS/model_pool mutation.",
            "darts_model": "DLinearModel",
            "max_windows": max_windows,
            "max_oos_windows": max_oos,
        },
    }
