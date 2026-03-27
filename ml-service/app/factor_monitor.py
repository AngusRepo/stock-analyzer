"""
factor_monitor.py — Factor IC 監控
每次 weekly retrain 時計算每個特徵的 Rank IC（Spearman 相關）
自動剔除失效因子，供 ensemble 調整權重

原理（FinLab Factor Analysis Framework）：
  IC = Spearman(feature_rank, future_return_rank) per cross-section
  |IC| > 0.02 且穩定 → 有效因子
  |IC| < 0.01 或 IC 持續下降 → 失效因子
"""
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from typing import Optional


def compute_factor_ic(
    df: pd.DataFrame,
    feature_cols: list[str],
    target_col: str = "target_5d",
    rolling_window: int = 60,
) -> pd.DataFrame:
    """
    計算每個特徵的 Rank IC（Spearman 相關性）

    Returns:
        DataFrame with columns: feature, ic_mean, ic_std, icir, ic_positive_pct, ic_trend, effective
        - ic_mean: 平均 IC
        - ic_std: IC 標準差
        - icir: IC/IC_std（Information Ratio，越高越穩定）
        - ic_positive_pct: IC > 0 的比例
        - ic_trend: 最近 IC 是否在下降（'stable' | 'declining' | 'improving'）
        - effective: 是否為有效因子（bool）
    """
    results = []

    available = [c for c in feature_cols if c in df.columns]
    if target_col not in df.columns:
        return pd.DataFrame(results)

    for feat in available:
        sub = df[[feat, target_col]].dropna()
        if len(sub) < rolling_window:
            results.append({
                "feature": feat,
                "ic_mean": 0.0,
                "ic_std": 1.0,
                "icir": 0.0,
                "ic_positive_pct": 0.5,
                "ic_trend": "insufficient_data",
                "effective": False,
                "sample_count": len(sub),
            })
            continue

        # 滾動 IC：每 rolling_window 天計算一次 Spearman
        ic_series = []
        step = max(1, rolling_window // 4)  # 每 15 天計算一次
        for start in range(0, len(sub) - rolling_window + 1, step):
            window = sub.iloc[start:start + rolling_window]
            corr, _ = spearmanr(window[feat], window[target_col])
            if not np.isnan(corr):
                ic_series.append(corr)

        if not ic_series:
            results.append({
                "feature": feat,
                "ic_mean": 0.0, "ic_std": 1.0, "icir": 0.0,
                "ic_positive_pct": 0.5, "ic_trend": "insufficient_data",
                "effective": False, "sample_count": len(sub),
            })
            continue

        ic_arr = np.array(ic_series)
        ic_mean = float(np.mean(ic_arr))
        ic_std = float(np.std(ic_arr)) if len(ic_arr) > 1 else 1.0
        icir = ic_mean / ic_std if ic_std > 0 else 0.0
        ic_pos_pct = float(np.mean(ic_arr > 0))

        # IC 趨勢偵測：最近 1/3 vs 前 2/3
        trend = "stable"
        if len(ic_arr) >= 6:
            split = len(ic_arr) * 2 // 3
            early_mean = np.mean(np.abs(ic_arr[:split]))
            late_mean = np.mean(np.abs(ic_arr[split:]))
            if late_mean < early_mean * 0.6:
                trend = "declining"
            elif late_mean > early_mean * 1.3:
                trend = "improving"

        # 有效因子判定：|IC mean| > 0.01 且 ICIR > 0.3 且趨勢非 declining
        effective = (
            abs(ic_mean) > 0.01
            and abs(icir) > 0.3
            and trend != "declining"
        )

        results.append({
            "feature": feat,
            "ic_mean": round(ic_mean, 4),
            "ic_std": round(ic_std, 4),
            "icir": round(icir, 4),
            "ic_positive_pct": round(ic_pos_pct, 4),
            "ic_trend": trend,
            "effective": effective,
            "sample_count": len(sub),
        })

    return pd.DataFrame(results)


def filter_effective_features(
    ic_df: pd.DataFrame,
    feature_cols: list[str],
    min_ic: float = 0.01,
) -> list[str]:
    """
    根據 IC 表篩選有效特徵

    Returns:
        有效的 feature_cols 子集（保持原始順序）
    """
    if ic_df.empty:
        return feature_cols  # 無 IC 資料時全保留

    effective_set = set(
        ic_df[ic_df["effective"] == True]["feature"].tolist()
    )

    # 至少保留一半特徵，避免過度剔除
    filtered = [c for c in feature_cols if c in effective_set]
    if len(filtered) < len(feature_cols) // 2:
        # fallback: 按 |IC mean| 排序取前半
        ic_df_sorted = ic_df.sort_values("ic_mean", key=abs, ascending=False)
        top_half = set(ic_df_sorted.head(len(feature_cols) // 2)["feature"].tolist())
        filtered = [c for c in feature_cols if c in top_half]

    return filtered if filtered else feature_cols


def compute_feature_weights_from_ic(
    ic_df: pd.DataFrame,
    feature_cols: list[str],
) -> dict[str, float]:
    """
    根據 IC 計算每個特徵的權重（用於 ensemble 加權）

    Returns:
        {feature_name: weight}，weights 總和 = 1.0
    """
    if ic_df.empty:
        # 等權重
        n = len(feature_cols)
        return {c: 1.0 / n for c in feature_cols}

    weights = {}
    for feat in feature_cols:
        row = ic_df[ic_df["feature"] == feat]
        if row.empty:
            weights[feat] = 0.5  # 無 IC 資料的特徵給中等權重
        else:
            # 權重 = |ICIR| × (1 if effective else 0.3)
            icir = abs(row.iloc[0]["icir"])
            eff = row.iloc[0]["effective"]
            weights[feat] = icir * (1.0 if eff else 0.3)

    # 歸一化
    total = sum(weights.values())
    if total > 0:
        weights = {k: v / total for k, v in weights.items()}
    else:
        n = len(feature_cols)
        weights = {c: 1.0 / n for c in feature_cols}

    return weights
