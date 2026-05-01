"""Sequence-model training contract for DLinear/PatchTST.

The sequence families are first-class lifecycle models only when their windows
carry symbol/date metadata. Raw close arrays can still train a fallback model,
but they cannot produce auditable cross-sectional OOS IC.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np


@dataclass(frozen=True)
class SequenceWindowDataset:
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
    dates: list[str] = []
    for row in prices_data or []:
        close_val = row.get("close")
        date_val = row.get("date")
        if close_val is None or not date_val:
            return None
        try:
            close = float(close_val)
        except Exception:
            return None
        if not np.isfinite(close) or close <= 0:
            return None
        closes.append(close)
        dates.append(str(date_val))
    if len(closes) < min_len:
        return None
    return {
        "symbol": str(symbol or ""),
        "market_type": str(market_type or "TW"),
        "close": closes,
        "dates": dates,
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
) -> SequenceWindowDataset:
    Xs: list[np.ndarray] = []
    ys: list[np.ndarray] = []
    meta: list[dict] = []
    dropped_short = 0
    dropped_bad = 0

    for record in records or []:
        closes = np.asarray(record.get("close") or record.get("series_close") or [], dtype=np.float32)
        dates = [str(d) for d in (record.get("dates") or [])]
        symbol = str(record.get("symbol") or "")
        market_type = str(record.get("market_type") or record.get("market") or "TW")
        if len(closes) < seq_len + pred_len or len(dates) != len(closes):
            dropped_short += 1
            continue
        if not np.isfinite(closes).all():
            dropped_bad += 1
            continue
        n_win = len(closes) - seq_len - pred_len + 1
        for start in range(n_win):
            x = closes[start:start + seq_len]
            y = closes[start + seq_len:start + seq_len + pred_len]
            last_close = float(x[-1])
            target_close = float(y[-1])
            Xs.append(x)
            ys.append(y)
            meta.append({
                "symbol": symbol,
                "market_type": market_type,
                "asof_date": dates[start + seq_len - 1],
                "target_date": dates[start + seq_len + pred_len - 1],
                "last_close": last_close,
                "target_close": target_close,
                "forward_return": (target_close - last_close) / max(last_close, 1e-9),
            })

    if not Xs:
        empty = np.asarray([], dtype=np.float32).reshape(0, seq_len)
        return SequenceWindowDataset(
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
    n_oos = max(1, int(n_total * oos_ratio))
    train_index = order[:-n_oos]
    oos_index = order[-n_oos:]
    report = {
        "input_series": len(records or []),
        "windows": int(n_total),
        "train_windows": int(len(train_index)),
        "oos_windows": int(len(oos_index)),
        "oos_dates": int(len(set(target_dates[oos_index].tolist()))),
        "dropped_short": dropped_short,
        "dropped_bad": dropped_bad,
        "lifecycle_ready": bool(len(train_index) > 0 and len(oos_index) > 0),
    }
    return SequenceWindowDataset(
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
    last_close = np.asarray([row["last_close"] for row in oos_meta], dtype=float)
    pred_returns = (forecast - last_close) / np.maximum(last_close, 1e-9)
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
