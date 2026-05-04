"""Model-level validation evidence for Modal training flows."""

from __future__ import annotations

import math
from statistics import mean, pstdev
from typing import Any, Callable

import numpy as np
from scipy.stats import spearmanr

from .purged_cv import CombinatorialPurgedCV


MODEL_CPCV_EVIDENCE_SCHEMA_VERSION = "model-cpcv-evidence-v1"


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _policy(policy: dict[str, Any] | None) -> dict[str, Any]:
    merged = {
        "min_folds": 5,
        "min_test_rows": 100,
        "min_oos_ic_mean": 0.0,
        "min_positive_fold_ratio": 0.55,
        "max_oos_ic_std": 0.20,
        "min_coverage": 0.60,
    }
    merged.update(policy or {})
    return merged


def rank_ic(preds: np.ndarray, y_actual: np.ndarray) -> float:
    if len(preds) < 10 or np.std(preds) < 1e-10 or np.std(y_actual) < 1e-10:
        return 0.0
    rho, _ = spearmanr(preds, y_actual)
    return float(rho) if not np.isnan(rho) else 0.0


def build_model_cpcv_evidence(
    *,
    model: str,
    fold_metrics: list[dict[str, Any]],
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    p = _policy(policy)
    rows = []
    for fold in fold_metrics or []:
        ic = _as_float(fold.get("oos_ic", fold.get("rank_ic")), math.nan)
        test_rows = _as_int(fold.get("test_rows"), 0)
        coverage = _as_float(fold.get("coverage"), 1.0 if test_rows > 0 else 0.0)
        if math.isfinite(ic):
            rows.append(
                {
                    "fold_id": fold.get("fold_id"),
                    "oos_ic": ic,
                    "test_rows": test_rows,
                    "coverage": coverage,
                }
            )

    ic_values = [row["oos_ic"] for row in rows]
    coverage_values = [row["coverage"] for row in rows]
    folds = len(rows)
    ic_mean = mean(ic_values) if ic_values else 0.0
    ic_std = pstdev(ic_values) if len(ic_values) > 1 else 0.0
    positive_ratio = sum(1 for value in ic_values if value > 0.0) / folds if folds else 0.0
    min_test_rows = min((row["test_rows"] for row in rows), default=0)
    coverage_mean = mean(coverage_values) if coverage_values else 0.0

    failed_gates: list[str] = []
    if folds < _as_int(p["min_folds"]):
        failed_gates.append("cpcv_fold_count")
    if min_test_rows < _as_int(p["min_test_rows"]):
        failed_gates.append("cpcv_test_rows")
    if ic_mean < _as_float(p["min_oos_ic_mean"]):
        failed_gates.append("cpcv_oos_ic")
    if positive_ratio < _as_float(p["min_positive_fold_ratio"]):
        failed_gates.append("cpcv_positive_fold_ratio")
    if ic_std > _as_float(p["max_oos_ic_std"]):
        failed_gates.append("cpcv_ic_instability")
    if coverage_mean < _as_float(p["min_coverage"]):
        failed_gates.append("cpcv_coverage")

    decision = "PASS" if not failed_gates else "FAIL"
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": model,
        "method": "purged_cpcv_rank_ic",
        "decision": decision,
        "passed": decision == "PASS",
        "failed_gates": failed_gates,
        "folds": folds,
        "oos_ic_mean": round(ic_mean, 6),
        "oos_ic_std": round(ic_std, 6),
        "positive_fold_ratio": round(positive_ratio, 6),
        "min_test_rows": min_test_rows,
        "coverage_mean": round(coverage_mean, 6),
        "policy": p,
        "fold_metrics": rows,
    }


def build_model_cpcv_adapter_missing_evidence(
    *,
    model: str,
    family: str,
    adapter: str,
    cost_estimate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": model,
        "family": family,
        "method": "family_specific_cpcv_adapter_missing",
        "decision": "FAIL",
        "passed": False,
        "failed_gates": ["cpcv_adapter_missing"],
        "folds": 0,
        "oos_ic_mean": 0.0,
        "oos_ic_std": 0.0,
        "positive_fold_ratio": 0.0,
        "min_test_rows": 0,
        "coverage_mean": 0.0,
        "adapter": adapter,
        "cost_estimate": cost_estimate or {},
        "reason": (
            "Non-tree models need family-specific CPCV fit_predict adapters; "
            "do not promote without explicit validation evidence."
        ),
    }


def build_model_cpcv_adapter_error_evidence(
    *,
    model: str,
    family: str,
    adapter: str,
    error: str,
    cost_estimate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": MODEL_CPCV_EVIDENCE_SCHEMA_VERSION,
        "model": model,
        "family": family,
        "method": "family_specific_cpcv_adapter_error",
        "decision": "FAIL",
        "passed": False,
        "failed_gates": ["cpcv_adapter_error"],
        "folds": 0,
        "oos_ic_mean": 0.0,
        "oos_ic_std": 0.0,
        "positive_fold_ratio": 0.0,
        "min_test_rows": 0,
        "coverage_mean": 0.0,
        "adapter": adapter,
        "error": error,
        "cost_estimate": cost_estimate or {},
        "reason": "Family-specific CPCV adapter failed; do not promote without validation evidence.",
    }


def fit_predict_ft_transformer_cpcv(
    X: np.ndarray,
    y: np.ndarray,
    train_idx: np.ndarray,
    test_idx: np.ndarray,
    *,
    params: dict[str, Any] | None = None,
) -> np.ndarray:
    """Train a small FT-Transformer fold and return rank-regression scores.

    This adapter is intentionally parameterized because full FT CPCV can be
    expensive. The architecture path is shared with persisted FT bundles so
    train/serve/CPCV do not become separate owners.
    """

    try:
        import torch
        import torch.nn as nn
    except ImportError as exc:
        raise RuntimeError("FT-Transformer CPCV adapter requires torch runtime") from exc
    from sklearn.preprocessing import StandardScaler

    from .ft_transformer import build_ft_transformer, rank_from_ft_regression_output

    p = dict(params or {})
    seed = _as_int(p.get("seed"), 42)
    torch.manual_seed(seed)
    np.random.seed(seed)
    device = torch.device(str(p.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")))
    arch = {
        "d_model": _as_int(p.get("d_model"), 64),
        "n_heads": _as_int(p.get("n_heads"), 4),
        "n_layers": _as_int(p.get("n_layers"), 2),
        "dropout": _as_float(p.get("dropout"), 0.10),
        "head_type": "regression",
    }
    max_epochs = max(1, _as_int(p.get("max_epochs"), 5))
    batch_size = max(8, _as_int(p.get("batch_size"), 512))
    lr = _as_float(p.get("lr"), 2e-4)
    margin = _as_float(p.get("margin"), 0.0)

    scaler = StandardScaler()
    X_train = scaler.fit_transform(np.asarray(X[train_idx], dtype=np.float32)).astype(np.float32)
    X_test = scaler.transform(np.asarray(X[test_idx], dtype=np.float32)).astype(np.float32)
    X_train = np.nan_to_num(X_train, nan=0.0, posinf=0.0, neginf=0.0)
    X_test = np.nan_to_num(X_test, nan=0.0, posinf=0.0, neginf=0.0)
    y_train = np.asarray(y[train_idx], dtype=np.float32)

    model, _ = build_ft_transformer(X_train.shape[1], "regression", {"arch": arch})
    model.to(device).train()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=5e-5)
    loss_fn = nn.MarginRankingLoss(margin=margin)

    def _pairwise_loss(preds: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        batch = preds.shape[0]
        if batch < 2:
            return torch.mean(preds * 0.0)
        n_pairs = min(512, batch * (batch - 1) // 2)
        idx_i = torch.randint(0, batch, (n_pairs,), device=preds.device)
        idx_j = torch.randint(0, batch, (n_pairs,), device=preds.device)
        mask = idx_i != idx_j
        idx_i, idx_j = idx_i[mask], idx_j[mask]
        target = torch.sign(labels[idx_i] - labels[idx_j])
        non_tie = target != 0
        if non_tie.sum() == 0:
            return torch.mean(preds * 0.0)
        return loss_fn(preds[idx_i[non_tie]], preds[idx_j[non_tie]], target[non_tie])

    for _ in range(max_epochs):
        perm = np.random.permutation(len(X_train))
        for start in range(0, len(perm), batch_size):
            bi = perm[start:start + batch_size]
            xb = torch.tensor(X_train[bi], device=device)
            yb = torch.tensor(y_train[bi], device=device)
            optimizer.zero_grad()
            preds = model(xb).float()
            loss = _pairwise_loss(preds, yb)
            loss.backward()
            optimizer.step()

    model.eval()
    out: list[np.ndarray] = []
    with torch.no_grad():
        for start in range(0, len(X_test), batch_size):
            xb = torch.tensor(X_test[start:start + batch_size], device=device)
            out.append(model(xb).float().cpu().numpy())
    raw = np.asarray(np.concatenate(out), dtype=float).reshape(-1)
    return np.asarray([rank_from_ft_regression_output(v) for v in raw], dtype=float)


def evaluate_model_cpcv_rank_ic(
    *,
    model: str,
    X: np.ndarray,
    y: np.ndarray,
    dates: np.ndarray,
    fit_predict: Callable[[np.ndarray, np.ndarray], np.ndarray],
    n_groups: int,
    n_test_groups: int,
    embargo_days: int,
    min_train_groups: int = 2,
    embargo_pct: float | None = None,
    max_embargo_days: int | None = 20,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cv = CombinatorialPurgedCV(
        n_groups=n_groups,
        n_test_groups=n_test_groups,
        embargo_days=embargo_days,
        embargo_pct=embargo_pct,
        max_embargo_days=max_embargo_days,
        min_train_groups=min_train_groups,
    )
    fold_metrics: list[dict[str, Any]] = []
    for fold_id, (train_idx, test_idx) in enumerate(cv.split(X, y, dates), start=1):
        preds = np.asarray(fit_predict(train_idx, test_idx), dtype=float).reshape(-1)
        y_test = np.asarray(y[test_idx], dtype=float).reshape(-1)
        if len(preds) != len(y_test):
            raise ValueError(
                f"{model} CPCV fold {fold_id} returned {len(preds)} preds for {len(y_test)} rows"
            )
        finite_mask = np.isfinite(preds) & np.isfinite(y_test)
        coverage = float(finite_mask.mean()) if len(finite_mask) else 0.0
        ic = rank_ic(preds[finite_mask], y_test[finite_mask]) if finite_mask.any() else 0.0
        fold_metrics.append(
            {
                "fold_id": fold_id,
                "oos_ic": ic,
                "test_rows": int(len(test_idx)),
                "coverage": coverage,
            }
        )
    return build_model_cpcv_evidence(model=model, fold_metrics=fold_metrics, policy=policy)
