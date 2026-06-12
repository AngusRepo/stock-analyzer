from __future__ import annotations

import time
from typing import Any, Callable

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


def normalize_windows(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = x.mean(axis=1, keepdims=True)
    std = x.std(axis=1, keepdims=True) + 1e-4
    return (x - mean) / std, mean, std


def sequence_fold_metrics(
    *,
    candidate_id: str,
    pred_return: np.ndarray,
    actual_return: np.ndarray,
    max_folds: int = 5,
) -> list[dict[str, Any]]:
    pred_return = np.asarray(pred_return, dtype=float).reshape(-1)
    actual_return = np.asarray(actual_return, dtype=float).reshape(-1)
    fold_metrics: list[dict[str, Any]] = []
    fold_count = min(max_folds, max(1, len(actual_return) // 30))
    for fold_id, idx in enumerate(np.array_split(np.arange(len(actual_return)), fold_count)):
        if len(idx) < 2:
            continue
        fold_metrics.append({
            "fold_id": f"{candidate_id}_oos_{fold_id}",
            "oos_ic": rank_ic(pred_return[idx], actual_return[idx]),
            "direction_accuracy": direction_accuracy(pred_return[idx], actual_return[idx]),
            "test_rows": int(len(idx)),
            "coverage": float(len(idx) / max(1, len(actual_return))),
        })
    if not fold_metrics:
        fold_metrics = [{
            "fold_id": f"{candidate_id}_oos_holdout",
            "oos_ic": rank_ic(pred_return, actual_return),
            "direction_accuracy": direction_accuracy(pred_return, actual_return),
            "test_rows": int(len(actual_return)),
            "coverage": 1.0 if len(actual_return) else 0.0,
        }]
    return fold_metrics


def run_torch_window_benchmark(
    payload: dict[str, Any],
    *,
    candidate_id: str,
    build_model: Callable[..., Any],
    default_d_model: int | None = None,
    default_n_heads: int | None = None,
    default_n_layers: int | None = None,
    default_dropout: float | None = None,
) -> dict[str, Any]:
    started_at = time.time()
    import torch

    seed = int(payload.get("seed") or payload.get("data_slice", {}).get("seed") or 42)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

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
        return {
            "status": "blocked",
            "candidate_id": candidate_id,
            "blockers": ["sequence_dataset_not_lifecycle_ready"],
            "data_slice_report": data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
        }

    max_windows = int(payload.get("max_windows") or payload.get("data_slice", {}).get("max_windows") or 8000)
    train_idx = np.arange(len(window_dataset.X_train))
    if len(train_idx) > max_windows:
        train_idx = np.linspace(0, len(train_idx) - 1, max_windows).astype(int)
    X_train = window_dataset.X_train[train_idx]
    y_train = window_dataset.y_train[train_idx]
    X_oos = window_dataset.X_oos
    y_oos = window_dataset.y_oos

    X_train_norm, mean_train, std_train = normalize_windows(X_train)
    y_train_norm = (y_train - mean_train) / std_train
    X_oos_norm, mean_oos, std_oos = normalize_windows(X_oos)

    kwargs: dict[str, Any] = {}
    if default_d_model is not None:
        kwargs["d_model"] = int(payload.get("d_model") or default_d_model)
    if default_n_heads is not None:
        kwargs["n_heads"] = int(payload.get("n_heads") or default_n_heads)
    if default_n_layers is not None:
        kwargs["n_layers"] = int(payload.get("n_layers") or default_n_layers)
    if default_dropout is not None:
        kwargs["dropout"] = float(payload.get("dropout") if payload.get("dropout") is not None else default_dropout)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = build_model(seq_len=seq_len, pred_len=pred_len, **kwargs).to(device)
    opt = torch.optim.AdamW(
        model.parameters(),
        lr=float(payload.get("lr") or 5e-4),
        weight_decay=float(payload.get("weight_decay") or 1e-5),
    )
    crit = torch.nn.MSELoss()
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(
            torch.tensor(X_train_norm, dtype=torch.float32),
            torch.tensor(y_train_norm, dtype=torch.float32),
        ),
        batch_size=int(payload.get("batch_size") or 256),
        shuffle=True,
        generator=torch.Generator().manual_seed(seed),
    )
    for _ in range(int(payload.get("epochs") or payload.get("data_slice", {}).get("epochs") or 8)):
        model.train()
        for xb, yb in loader:
            xb = xb.to(device)
            yb = yb.to(device)
            opt.zero_grad(set_to_none=True)
            loss = crit(model(xb), yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=3.0)
            opt.step()

    model.eval()
    with torch.no_grad():
        forecast_norm = model(torch.tensor(X_oos_norm, dtype=torch.float32, device=device)).detach().cpu().numpy()
    forecast = forecast_norm * std_oos + mean_oos
    forecast_last = forecast[:, -1]
    actual_last = y_oos[:, -1]
    last_close = np.asarray([window_dataset.meta[int(idx)]["last_close"] for idx in window_dataset.oos_index], dtype=float)
    pred_return = (forecast_last - last_close) / np.maximum(last_close, 1e-9)
    actual_return = (actual_last - last_close) / np.maximum(last_close, 1e-9)
    fold_metrics = sequence_fold_metrics(
        candidate_id=candidate_id,
        pred_return=pred_return,
        actual_return=actual_return,
    )
    return {
        "status": "available",
        "candidate_id": candidate_id,
        "fold_metrics": fold_metrics,
        "pbo": cpcv_proxy_pbo(fold_metrics),
        "cost_sensitivity": cost_sensitivity(started_at, gpu=str(device) if device.type == "cuda" else None, rows=int(window_dataset.report.get("windows", 0)), folds=len(fold_metrics)),
        "data_slice_report": {
            **data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
            "sequence_report": window_dataset.report,
            "adapter_note": "StockVision in-repo artifact architecture evaluated read-only; no GCS/model_pool mutation.",
        },
    }
