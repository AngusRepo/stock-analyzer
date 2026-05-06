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


def _normalize(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = x.mean(axis=1, keepdims=True)
    std = x.std(axis=1, keepdims=True) + 1e-4
    return (x - mean) / std, mean, std


def _build_itransformer(seq_len: int, pred_len: int, *, d_model: int = 64, n_heads: int = 4, n_layers: int = 2, dropout: float = 0.1):
    import torch
    import torch.nn as nn

    class ResearchITransformer(nn.Module):
        """Small inverted-transformer style baseline for research benchmarks.

        It embeds each time series window as a variate token, applies vanilla
        TransformerEncoder layers, then maps the token representation to the
        forecast horizon. Full paper-style multivariate panels can replace this
        adapter without changing the benchmark contract.
        """

        def __init__(self):
            super().__init__()
            self.value_embedding = nn.Linear(seq_len, d_model)
            layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=n_heads,
                dim_feedforward=d_model * 4,
                dropout=dropout,
                batch_first=True,
                activation="gelu",
            )
            self.encoder = nn.TransformerEncoder(layer, num_layers=n_layers)
            self.projection = nn.Linear(d_model, pred_len)

        def forward(self, x):
            # x: (B, L) -> (B, 1, L), a single variate token per stock window.
            token = self.value_embedding(x.unsqueeze(1))
            encoded = self.encoder(token)
            return self.projection(encoded.squeeze(1))

    return ResearchITransformer()


def run_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = time.time()
    import torch

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
            "candidate_id": "iTransformer",
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

    X_train_norm, mean_train, std_train = _normalize(X_train)
    y_train_norm = (y_train - mean_train) / std_train
    X_oos_norm, mean_oos, std_oos = _normalize(X_oos)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = _build_itransformer(
        seq_len,
        pred_len,
        d_model=int(payload.get("d_model") or 64),
        n_heads=int(payload.get("n_heads") or 4),
        n_layers=int(payload.get("n_layers") or 2),
    ).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=float(payload.get("lr") or 5e-4), weight_decay=1e-5)
    crit = torch.nn.MSELoss()
    batch_size = int(payload.get("batch_size") or 256)
    epochs = int(payload.get("epochs") or payload.get("data_slice", {}).get("epochs") or 8)
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(
            torch.tensor(X_train_norm, dtype=torch.float32),
            torch.tensor(y_train_norm, dtype=torch.float32),
        ),
        batch_size=batch_size,
        shuffle=True,
    )
    model.train()
    for _ in range(epochs):
        for xb, yb in loader:
            xb = xb.to(device)
            yb = yb.to(device)
            opt.zero_grad()
            loss = crit(model(xb), yb)
            loss.backward()
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
    fold_metrics: list[dict[str, Any]] = []
    for fold_id, idx in enumerate(np.array_split(np.arange(len(actual_return)), min(5, max(1, len(actual_return) // 30)))):
        if len(idx) < 2:
            continue
        fold_metrics.append({
            "fold_id": f"itransformer_oos_{fold_id}",
            "oos_ic": rank_ic(pred_return[idx], actual_return[idx]),
            "direction_accuracy": direction_accuracy(pred_return[idx], actual_return[idx]),
            "test_rows": int(len(idx)),
            "coverage": float(len(idx) / max(1, len(actual_return))),
        })
    if not fold_metrics:
        fold_metrics = [{
            "fold_id": "itransformer_oos_holdout",
            "oos_ic": rank_ic(pred_return, actual_return),
            "direction_accuracy": direction_accuracy(pred_return, actual_return),
            "test_rows": int(len(actual_return)),
            "coverage": 1.0,
        }]
    return {
        "status": "available",
        "candidate_id": "iTransformer",
        "fold_metrics": fold_metrics,
        "pbo": cpcv_proxy_pbo(fold_metrics),
        "cost_sensitivity": cost_sensitivity(started_at, gpu=str(device) if device.type == "cuda" else None, rows=int(window_dataset.report.get("windows", 0)), folds=len(fold_metrics)),
        "data_slice_report": {
            **data_slice_report(dataset=dataset_source, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
            "sequence_report": window_dataset.report,
            "adapter_note": "research inverted-transformer baseline; production challenger requires reviewed multivariate panel spec",
        },
    }
