"""
_features.py — Triple Barrier label calculator (standalone copy from ml-service/app/features)
2026-04-07 added: 讓 optuna_scripts 不依賴 ml-service.app

Phase 1.6 KV Pivot：optuna_scripts 從 Modal 移到 Cloud Run，需要這份 standalone 版避免 cross-service import
Phase 2: pd.Series → np.ndarray (零 Pandas)
"""
import numpy as np


def compute_triple_barrier_labels(
    close: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    atr14: np.ndarray,
    upper_atr_mult: float = 3.0,
    lower_atr_mult: float = 2.0,
    upper_pct_cap: float = 0.07,
    lower_pct_cap: float = 0.03,
    max_days: int = 20,
) -> np.ndarray:
    """
    Triple Barrier (Prado 2018):
      1 = 先觸及上界（停利）
      0 = 先觸及下界（停損）
      NaN = 到期未觸碰
    """
    n = len(close)
    labels = np.full(n, np.nan, dtype=float)

    for i in range(n - 1):
        price = close[i]
        if np.isnan(price) or price <= 0:
            continue

        atr = atr14[i] if not np.isnan(atr14[i]) else price * 0.02
        upper_barrier = price + min(atr * upper_atr_mult, price * upper_pct_cap)
        lower_barrier = price - min(atr * lower_atr_mult, price * lower_pct_cap)

        end_idx = min(i + max_days, n - 1)
        if end_idx <= i:
            continue

        for j in range(i + 1, end_idx + 1):
            h = high[j]
            lo = low[j]
            if np.isnan(h) or np.isnan(lo):
                continue
            hit_upper = h >= upper_barrier
            hit_lower = lo <= lower_barrier
            if hit_upper and hit_lower:
                c_j = close[j] if not np.isnan(close[j]) else price
                labels[i] = 1.0 if c_j >= price else 0.0
                break
            elif hit_upper:
                labels[i] = 1.0
                break
            elif hit_lower:
                labels[i] = 0.0
                break

    return labels
