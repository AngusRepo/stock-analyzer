from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

import numpy as np

from .common import cost_sensitivity, cpcv_proxy_pbo, data_slice_report, load_sequence_dataset
from .sequence_adapter_common import sequence_fold_metrics


def _panel_rows(records: list[dict[str, Any]], *, pred_len: int, max_series: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    train_rows: list[dict[str, Any]] = []
    eval_rows: list[dict[str, Any]] = []
    for row in records[:max_series]:
        close: list[float] = []
        for value in row.get("close") or row.get("series_close") or []:
            try:
                parsed = float(value)
            except (TypeError, ValueError):
                continue
            if np.isfinite(parsed):
                close.append(parsed)
        dates = [str(v) for v in (row.get("dates") or [])]
        if len(close) < pred_len + 10:
            continue
        if len(dates) != len(close):
            base = date(2000, 1, 1)
            dates = [(base + timedelta(days=idx)).isoformat() for idx in range(len(close))]
        symbol = str(row.get("symbol") or f"series_{len(eval_rows)}")
        train_close = close[:-pred_len]
        actual_close = close[-pred_len:]
        eval_dates = dates[-pred_len:]
        if not train_close or not actual_close:
            continue
        for ds_idx, y in enumerate(train_close):
            train_rows.append({"unique_id": symbol, "ds": int(ds_idx), "y": float(y)})
        eval_rows.append({
            "unique_id": symbol,
            "last_close": float(train_close[-1]),
            "actual_last": float(actual_close[-1]),
            "target_date": eval_dates[-1],
        })
    return train_rows, eval_rows


def _prediction_column(pred_df: Any, model_name: str) -> str | None:
    if model_name in pred_df.columns:
        return model_name
    candidate_cols = [
        str(col)
        for col in pred_df.columns
        if str(col) not in {"unique_id", "ds", "index", "level_0"}
    ]
    return candidate_cols[0] if len(candidate_cols) == 1 else None


def run_neuralforecast_benchmark(payload: dict[str, Any], *, candidate_id: str, model_name: str) -> dict[str, Any]:
    started_at = time.time()
    try:
        import pandas as pd
        from neuralforecast import NeuralForecast
        from neuralforecast.models import PatchTST, iTransformer
    except Exception as exc:  # noqa: BLE001
        return {"status": "blocked", "candidate_id": candidate_id, "blockers": [f"missing_neuralforecast_runtime:{type(exc).__name__}:{exc}"]}

    seq_len = int(payload.get("seq_len") or payload.get("data_slice", {}).get("seq_len") or 60)
    pred_len = int(payload.get("pred_len") or payload.get("data_slice", {}).get("pred_len") or 5)
    dataset_source = load_sequence_dataset(payload)
    max_series = int(payload.get("max_series") or payload.get("data_slice", {}).get("max_series") or 256)
    train_rows, eval_rows = _panel_rows(dataset_source.records, pred_len=pred_len, max_series=max_series)
    if len(eval_rows) < 10:
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "blockers": ["insufficient_sequence_panel_for_neuralforecast"],
            "data_slice_report": data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
        }

    max_steps = int(payload.get("max_steps") or payload.get("data_slice", {}).get("max_steps") or 100)
    common_kwargs = {
        "h": pred_len,
        "input_size": seq_len,
        "max_steps": max_steps,
        "batch_size": int(payload.get("batch_size") or 32),
        "random_seed": int(payload.get("seed") or 42),
    }
    model = (
        PatchTST(**common_kwargs)
        if model_name == "PatchTST"
        else iTransformer(n_series=len(eval_rows), **common_kwargs)
    )

    try:
        df = pd.DataFrame(train_rows)
        nf = NeuralForecast(models=[model], freq=int(payload.get("freq") or payload.get("data_slice", {}).get("freq") or 1))
        nf.fit(df=df)
        pred_df = nf.predict()
        if "unique_id" not in pred_df.columns or "ds" not in pred_df.columns:
            pred_df = pred_df.reset_index()
    except Exception as exc:  # noqa: BLE001
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "blockers": [f"neuralforecast_runtime_error:{type(exc).__name__}:{exc}"],
            "data_slice_report": data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
        }

    pred_col = _prediction_column(pred_df, model_name)
    if not pred_col:
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "blockers": ["neuralforecast_prediction_column_missing"],
            "data_slice_report": {
                **data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
                "prediction_columns": [str(col) for col in pred_df.columns],
            },
        }
    last_pred = (
        pred_df.sort_values(["unique_id", "ds"])
        .groupby("unique_id", as_index=False)
        .tail(1)[["unique_id", pred_col]]
    )
    pred_by_id = {str(row["unique_id"]): float(row[pred_col]) for _, row in last_pred.iterrows()}
    pred_return: list[float] = []
    actual_return: list[float] = []
    for row in eval_rows:
        uid = str(row["unique_id"])
        if uid not in pred_by_id:
            continue
        last_close = float(row["last_close"])
        pred_return.append((pred_by_id[uid] - last_close) / max(last_close, 1e-9))
        actual_return.append((float(row["actual_last"]) - last_close) / max(last_close, 1e-9))
    fold_metrics = sequence_fold_metrics(
        candidate_id=candidate_id,
        pred_return=np.asarray(pred_return, dtype=float),
        actual_return=np.asarray(actual_return, dtype=float),
    )
    return {
        "status": "available",
        "candidate_id": candidate_id,
        "fold_metrics": fold_metrics,
        "pbo": cpcv_proxy_pbo(fold_metrics),
        "cost_sensitivity": cost_sensitivity(started_at, gpu="lightning_auto", rows=len(train_rows), folds=len(fold_metrics)),
        "data_slice_report": {
            **data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
            "adapter_note": f"NeuralForecast {model_name} maintained-library holdout benchmark.",
            "max_series": max_series,
            "train_rows": len(train_rows),
            "eval_series": len(eval_rows),
            "max_steps": max_steps,
        },
    }
