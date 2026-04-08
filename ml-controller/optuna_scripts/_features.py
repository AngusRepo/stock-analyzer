"""
_features.py — Triple Barrier label calculator (standalone copy from ml-service/app/features)
2026-04-07 added: 讓 optuna_scripts 不依賴 ml-service.app

Phase 1.6 KV Pivot：optuna_scripts 從 Modal 移到 Cloud Run，需要這份 standalone 版避免 cross-service import
"""
import numpy as np
import pandas as pd


def compute_triple_barrier_labels(
    close: pd.Series,
    high: pd.Series,
    low: pd.Series,
    atr14: pd.Series,
    upper_atr_mult: float = 3.0,
    lower_atr_mult: float = 2.0,
    upper_pct_cap: float = 0.07,
    lower_pct_cap: float = 0.03,
    max_days: int = 20,
) -> pd.Series:
    """
    Triple Barrier (Prado 2018):
      1 = 先觸及上界（停利）
      0 = 先觸及下界（停損）
      NaN = 到期未觸碰
    """
    n = len(close)
    labels = pd.Series(np.nan, index=close.index, dtype=float)

    close_arr = close.values
    high_arr = high.values
    low_arr = low.values
    atr_arr = atr14.values

    for i in range(n - 1):
        price = close_arr[i]
        if np.isnan(price) or price <= 0:
            continue

        atr = atr_arr[i] if not np.isnan(atr_arr[i]) else price * 0.02
        upper_barrier = price + min(atr * upper_atr_mult, price * upper_pct_cap)
        lower_barrier = price - min(atr * lower_atr_mult, price * lower_pct_cap)

        end_idx = min(i + max_days, n - 1)
        if end_idx <= i:
            continue

        for j in range(i + 1, end_idx + 1):
            h = high_arr[j]
            lo = low_arr[j]
            if np.isnan(h) or np.isnan(lo):
                continue
            hit_upper = h >= upper_barrier
            hit_lower = lo <= lower_barrier
            if hit_upper and hit_lower:
                c_j = close_arr[j] if not np.isnan(close_arr[j]) else price
                labels.iloc[i] = 1.0 if c_j >= price else 0.0
                break
            elif hit_upper:
                labels.iloc[i] = 1.0
                break
            elif hit_lower:
                labels.iloc[i] = 0.0
                break

    return labels
