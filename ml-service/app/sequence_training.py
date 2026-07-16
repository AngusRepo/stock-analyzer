"""Sequence-model training contract for DLinear/PatchTST/iTransformer.

The sequence families are first-class lifecycle models only when their windows
carry symbol/date metadata. Raw close arrays can still train a fallback model,
but they cannot produce auditable cross-sectional OOS IC.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np


SEQUENCE_RETURN_SEMANTIC_VERSION = (
    "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
)
CANONICAL_ROUNDTRIP_COST_BPS = 18.0


@dataclass(frozen=True)
class SequenceWindowDataset:
    X_all: np.ndarray
    y_all: np.ndarray
    X_train: np.ndarray
    y_train: np.ndarray
    X_oos: np.ndarray
    y_oos: np.ndarray
    train_index: np.ndarray
    oos_index: np.ndarray
    meta: list[dict]
    report: dict


def build_sequence_record(
    *,
    symbol: str,
    market_type: str,
    prices_data: list[dict],
    min_len: int,
) -> dict | None:
    closes: list[float] = []
    opens: list[float] = []
    dates: list[str] = []
    for row in prices_data or []:
        close_val = row.get("close")
        open_val = row.get("open")
        date_val = row.get("date")
        if close_val is None or open_val is None or not date_val:
            return None
        try:
            close = float(close_val)
            open_price = float(open_val)
        except Exception:
            return None
        if not np.isfinite(close) or close <= 0 or not np.isfinite(open_price) or open_price <= 0:
            return None
        closes.append(close)
        opens.append(open_price)
        dates.append(str(date_val))
    if len(closes) < min_len:
        return None
    return {
        "symbol": str(symbol or ""),
        "market_type": str(market_type or "TW"),
        "close": closes,
        "open": opens,
        "dates": dates,
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
    }


def _spearman_corr(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 3 or len(b) < 3:
        return float("nan")
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    if np.std(ra) == 0 or np.std(rb) == 0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def mean_daily_spearman_ic(
    *,
    predictions: np.ndarray,
    actual_returns: np.ndarray,
    target_dates: Iterable[str],
) -> dict:
    dates = np.asarray(list(target_dates), dtype=str)
    preds = np.asarray(predictions, dtype=float).reshape(-1)
    actual = np.asarray(actual_returns, dtype=float).reshape(-1)
    if not (len(dates) == len(preds) == len(actual)):
        raise ValueError("sequence IC inputs must have identical length")

    daily_ics: list[float] = []
    for date in sorted(set(dates.tolist())):
        mask = dates == date
        if int(mask.sum()) < 3:
            continue
        ic = _spearman_corr(preds[mask], actual[mask])
        if np.isfinite(ic):
            daily_ics.append(ic)

    mean_ic = float(np.mean(daily_ics)) if daily_ics else 0.0
    return {
        "oos_ic": round(mean_ic, 4),
        "daily_ic_count": len(daily_ics),
        "passed": mean_ic > 0,
    }


def build_sequence_window_dataset(
    records: list[dict],
    *,
    seq_len: int,
    pred_len: int,
    oos_ratio: float = 0.2,
    train_start: str | None = None,
    train_end: str | None = None,
    test_start: str | None = None,
    test_end: str | None = None,
) -> SequenceWindowDataset:
    Xs: list[np.ndarray] = []
    ys: list[np.ndarray] = []
    meta: list[dict] = []
    dropped_short = 0
    dropped_bad = 0

    for record in records or []:
        closes = np.asarray(record.get("close") or record.get("series_close") or [], dtype=np.float32)
        opens = np.asarray(record.get("open") or record.get("series_open") or [], dtype=np.float32)
        dates = [str(d) for d in (record.get("dates") or [])]
        symbol = str(record.get("symbol") or "")
        market_type = str(record.get("market_type") or record.get("market") or "TW")
        if (
            len(closes) < seq_len + pred_len
            or len(dates) != len(closes)
            or len(opens) != len(closes)
        ):
            dropped_short += 1
            continue
        if not np.isfinite(closes).all() or not np.isfinite(opens).all() or np.any(opens <= 0):
            dropped_bad += 1
            continue
        n_win = len(closes) - seq_len - pred_len + 1
        for start in range(n_win):
            x = closes[start:start + seq_len]
            y = closes[start + seq_len:start + seq_len + pred_len]
            last_close = float(x[-1])
            entry_open = float(opens[start + seq_len])
            target_close = float(y[-1])
            Xs.append(x)
            ys.append(y)
            meta.append({
                "symbol": symbol,
                "market_type": market_type,
                "asof_date": dates[start + seq_len - 1],
                "target_date": dates[start + seq_len + pred_len - 1],
                "last_close": last_close,
                "entry_open": entry_open,
                "target_close": target_close,
                "forward_return": (
                    (target_close - entry_open) / max(entry_open, 1e-9)
                    - CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
                ),
                "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
            })

    if not Xs:
        empty = np.asarray([], dtype=np.float32).reshape(0, seq_len)
        return SequenceWindowDataset(
            X_all=empty,
            y_all=np.asarray([], dtype=np.float32).reshape(0, pred_len),
            X_train=empty,
            y_train=np.asarray([], dtype=np.float32).reshape(0, pred_len),
            X_oos=empty,
            y_oos=np.asarray([], dtype=np.float32).reshape(0, pred_len),
            train_index=np.asarray([], dtype=int),
            oos_index=np.asarray([], dtype=int),
            meta=[],
            report={
                "input_series": len(records or []),
                "windows": 0,
                "dropped_short": dropped_short,
                "dropped_bad": dropped_bad,
                "lifecycle_ready": False,
                "reason": "no_valid_windows",
            },
        )

    X = np.stack(Xs)
    y = np.stack(ys)
    target_dates = np.asarray([row["target_date"] for row in meta], dtype=str)
    order = np.argsort(target_dates, kind="stable")
    n_total = len(order)
    explicit_ranges = all((train_start, train_end, test_start, test_end))
    if explicit_ranges:
        asof_dates = np.asarray([row["asof_date"] for row in meta], dtype=str)
        train_index = np.flatnonzero(
            (asof_dates >= str(train_start))
            & (asof_dates <= str(train_end))
            & (target_dates < str(test_start))
        )
        oos_index = np.flatnonzero(
            (asof_dates >= str(test_start)) & (asof_dates <= str(test_end))
        )
        split_method = "explicit_signal_date_with_actual_label_purge"
    else:
        n_oos = max(1, int(n_total * oos_ratio))
        train_index = order[:-n_oos]
        oos_index = order[-n_oos:]
        split_method = "chronological_ratio_holdout"
    report = {
        "input_series": len(records or []),
        "windows": int(n_total),
        "train_windows": int(len(train_index)),
        "oos_windows": int(len(oos_index)),
        "oos_dates": int(len(set(target_dates[oos_index].tolist()))),
        "dropped_short": dropped_short,
        "dropped_bad": dropped_bad,
        "lifecycle_ready": bool(len(train_index) > 0 and len(oos_index) > 0),
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        "split_method": split_method,
        "train_range": [train_start, train_end] if explicit_ranges else None,
        "test_range": [test_start, test_end] if explicit_ranges else None,
    }
    return SequenceWindowDataset(
        X_all=X,
        y_all=y,
        X_train=X[train_index],
        y_train=y[train_index],
        X_oos=X[oos_index],
        y_oos=y[oos_index],
        train_index=train_index,
        oos_index=oos_index,
        meta=meta,
        report=report,
    )


def sequence_oos_ic_from_forecast(
    *,
    forecast_prices: np.ndarray,
    dataset: SequenceWindowDataset,
) -> dict:
    forecast = np.asarray(forecast_prices, dtype=float).reshape(-1)
    oos_meta = [dataset.meta[int(idx)] for idx in dataset.oos_index]
    actual_returns = np.asarray([row["forward_return"] for row in oos_meta], dtype=float)
    entry_open = np.asarray([row["entry_open"] for row in oos_meta], dtype=float)
    pred_returns = (forecast - entry_open) / np.maximum(entry_open, 1e-9)
    target_dates = [row["target_date"] for row in oos_meta]
    ic = mean_daily_spearman_ic(
        predictions=pred_returns,
        actual_returns=actual_returns,
        target_dates=target_dates,
    )
    ic.update({
        "oos_samples": int(len(pred_returns)),
        "oos_dates": int(len(set(target_dates))),
    })
    return ic


def build_sequence_oos_fold_evidence(
    *,
    model: str,
    dataset: SequenceWindowDataset,
    forecast_prices: np.ndarray,
    policy: dict | None = None,
) -> dict:
    ic = sequence_oos_ic_from_forecast(forecast_prices=forecast_prices, dataset=dataset)
    return {
        "schema_version": "model-cpcv-evidence-v2",
        "model": model,
        "method": "chronological_holdout_rank_ic",
        "decision": "FAIL",
        "passed": False,
        "failed_gates": ["sequence_temporal_refit_required"],
        "reason": "A single chronological holdout is monitoring evidence, not promotion-grade CPCV.",
        "folds": 1,
        "oos_ic_mean": ic.get("oos_ic", 0.0),
        "min_test_rows": ic.get("oos_samples", 0),
        "coverage_mean": 1.0 if ic.get("oos_samples", 0) else 0.0,
        "family": "sequence_model",
        "date_field": "target_date",
        "input_contract": "SequenceWindowDataset(symbol,target_date,entry_open,forward_return)",
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        "oos_dates": ic.get("oos_dates", 0),
        "daily_ic_count": ic.get("daily_ic_count", 0),
        "validation_design": {
            "split_owner": "chronological_target_date",
            "refit_each_fold": False,
            "promotion_grade": False,
        },
        "policy": policy or {},
    }


def sequence_cpcv_policy_enabled(policy: dict | None, model: str) -> bool:
    if not isinstance(policy, dict):
        return False
    adapters = policy.get("family_adapters")
    if not isinstance(adapters, dict):
        return False
    cfg = adapters.get(model)
    return bool(isinstance(cfg, dict) and cfg.get("enabled") is True)


def build_sequence_cpcv_evidence(
    *,
    model: str,
    dataset: SequenceWindowDataset,
    fit_predict: Callable[[np.ndarray, np.ndarray], np.ndarray],
    n_groups: int,
    n_test_groups: int,
    embargo_days: int,
    min_train_groups: int = 2,
    embargo_pct: float | None = None,
    max_embargo_days: int | None = 20,
    policy: dict | None = None,
) -> dict:
    from .model_validation import build_model_cpcv_evidence
    from .purged_cv import CombinatorialPurgedCV

    if not dataset.report.get("lifecycle_ready") or len(dataset.meta) == 0:
        return build_model_cpcv_evidence(
            model=model,
            fold_metrics=[],
            policy=policy,
        ) | {
            "method": "purged_cpcv_sequence_rank_ic",
            "failed_gates": ["sequence_dataset_not_lifecycle_ready"],
            "reason": dataset.report.get("reason") or "sequence_dataset_not_lifecycle_ready",
        }

    target_dates = np.asarray([row["target_date"] for row in dataset.meta], dtype=str)
    actual_returns_all = np.asarray([row["forward_return"] for row in dataset.meta], dtype=float)
    last_close_all = np.asarray([row["last_close"] for row in dataset.meta], dtype=float)
    cv = CombinatorialPurgedCV(
        n_groups=n_groups,
        n_test_groups=n_test_groups,
        embargo_days=embargo_days,
        embargo_pct=embargo_pct,
        max_embargo_days=max_embargo_days,
        min_train_groups=min_train_groups,
    )
    fold_metrics: list[dict] = []
    for fold_id, (train_idx, test_idx) in enumerate(
        cv.split(dataset.X_all, actual_returns_all, target_dates),
        start=1,
    ):
        forecast_prices = np.asarray(fit_predict(train_idx, test_idx), dtype=float).reshape(-1)
        if len(forecast_prices) != len(test_idx):
            raise ValueError(
                f"{model} sequence CPCV fold {fold_id} returned "
                f"{len(forecast_prices)} forecasts for {len(test_idx)} rows"
            )
        pred_returns = (forecast_prices - last_close_all[test_idx]) / np.maximum(last_close_all[test_idx], 1e-9)
        finite_mask = np.isfinite(pred_returns) & np.isfinite(actual_returns_all[test_idx])
        coverage = float(finite_mask.mean()) if len(finite_mask) else 0.0
        if finite_mask.any():
            ic = mean_daily_spearman_ic(
                predictions=pred_returns[finite_mask],
                actual_returns=actual_returns_all[test_idx][finite_mask],
                target_dates=target_dates[test_idx][finite_mask],
            )["oos_ic"]
        else:
            ic = 0.0
        fold_metrics.append(
            {
                "fold_id": fold_id,
                "oos_ic": ic,
                "test_rows": int(len(test_idx)),
                "coverage": coverage,
            }
        )

    evidence = build_model_cpcv_evidence(model=model, fold_metrics=fold_metrics, policy=policy)
    evidence["method"] = "purged_cpcv_sequence_rank_ic"
    evidence["family"] = "sequence_model"
    evidence["date_field"] = "target_date"
    evidence["input_contract"] = "SequenceWindowDataset(symbol,target_date,last_close,forward_return)"
    return evidence
