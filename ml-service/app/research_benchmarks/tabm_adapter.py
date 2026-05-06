from __future__ import annotations

import time
from typing import Any

import numpy as np

from .common import (
    contiguous_fold_indices,
    cost_sensitivity,
    cpcv_proxy_pbo,
    data_slice_report,
    direction_accuracy,
    load_tabular_dataset,
    rank_ic,
)


def _predict_mean(output):
    import torch

    if isinstance(output, tuple):
        output = output[0]
    if output.ndim == 3:
        output = output.mean(dim=1)
    return output.reshape(-1)


def _make_model(n_features: int):
    from tabm import TabM

    try:
        return TabM.make(n_num_features=n_features, cat_cardinalities=[], d_out=1)
    except TypeError:
        return TabM.make(n_num_features=n_features, d_out=1)


def run_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    """Train TabM research benchmark and return OOS fold evidence."""
    started_at = time.time()
    import torch
    from sklearn.preprocessing import StandardScaler

    dataset = load_tabular_dataset(payload)
    max_rows = int(payload.get("max_rows") or payload.get("data_slice", {}).get("max_rows") or 6000)
    if len(dataset.y) > max_rows:
        keep = np.linspace(0, len(dataset.y) - 1, max_rows).astype(int)
        dataset.X = dataset.X[keep]
        dataset.y = dataset.y[keep]
        dataset.dates = dataset.dates[keep]
        dataset.sectors = dataset.sectors[keep]

    folds = contiguous_fold_indices(len(dataset.y), n_folds=int(payload.get("folds") or 5))
    if not folds:
        return {
            "status": "blocked",
            "candidate_id": "TabM",
            "blockers": ["insufficient_rows_for_folds"],
            "data_slice_report": data_slice_report(dataset=dataset, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
        }

    epochs = int(payload.get("epochs") or payload.get("data_slice", {}).get("epochs") or 8)
    batch_size = int(payload.get("batch_size") or 512)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    fold_metrics: list[dict[str, Any]] = []

    for fold_id, (train_idx, test_idx) in enumerate(folds):
        scaler_x = StandardScaler()
        scaler_y = StandardScaler()
        X_train = scaler_x.fit_transform(dataset.X[train_idx]).astype(np.float32)
        y_train = scaler_y.fit_transform(dataset.y[train_idx].reshape(-1, 1)).astype(np.float32).reshape(-1)
        X_test = scaler_x.transform(dataset.X[test_idx]).astype(np.float32)
        y_test = dataset.y[test_idx].astype(np.float32).reshape(-1)

        model = _make_model(X_train.shape[1]).to(device)
        opt = torch.optim.AdamW(model.parameters(), lr=0.002, weight_decay=0.0003)
        crit = torch.nn.MSELoss()
        x_tensor = torch.tensor(X_train, dtype=torch.float32)
        y_tensor = torch.tensor(y_train, dtype=torch.float32)
        loader = torch.utils.data.DataLoader(
            torch.utils.data.TensorDataset(x_tensor, y_tensor),
            batch_size=batch_size,
            shuffle=True,
        )
        model.train()
        for _ in range(epochs):
            for xb, yb in loader:
                xb = xb.to(device)
                yb = yb.to(device)
                opt.zero_grad()
                pred = _predict_mean(model(xb))
                loss = crit(pred, yb)
                loss.backward()
                opt.step()

        model.eval()
        with torch.no_grad():
            pred_scaled = _predict_mean(model(torch.tensor(X_test, dtype=torch.float32, device=device))).detach().cpu().numpy()
        pred = scaler_y.inverse_transform(pred_scaled.reshape(-1, 1)).reshape(-1)
        fold_metrics.append({
            "fold_id": f"tabm_fold_{fold_id}",
            "oos_ic": rank_ic(pred, y_test),
            "direction_accuracy": direction_accuracy(pred, y_test),
            "test_rows": int(len(test_idx)),
            "coverage": 1.0,
        })

    return {
        "status": "available",
        "candidate_id": "TabM",
        "fold_metrics": fold_metrics,
        "pbo": cpcv_proxy_pbo(fold_metrics),
        "cost_sensitivity": cost_sensitivity(started_at, gpu=str(device) if device.type == "cuda" else None, rows=len(dataset.y), folds=len(fold_metrics)),
        "data_slice_report": data_slice_report(dataset=dataset, start_date=payload.get("start_date"), end_date=payload.get("end_date")),
    }
