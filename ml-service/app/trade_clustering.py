"""
trade_clustering.py — MAE/MFE 分群分析
用歷史交易的 max_adverse_pct (MAE) + max_favorable_pct (MFE)
KMeans 分群找出好交易/一般/差交易的模式
DecisionTree 學習什麼因子區分好壞交易 → 回饋 screener 評分

原理（FinLab）：
  MAE = 持倉期間最大不利偏移（最深虧損）
  MFE = 持倉期間最大有利偏移（最高獲利）
  KMeans(n=3) → 好/一般/差
  DecisionTree → 學哪些因子決定好壞
"""
import numpy as np
import pandas as pd
from typing import Optional


def cluster_trades(
    trades: list[dict],
    n_clusters: int = 3,
) -> dict:
    """
    對歷史交易做 MAE/MFE KMeans 分群

    trades: [{
        symbol, max_favorable_pct, max_adverse_pct,
        trade_pnl_pct, confidence, signal_strength, ...features...
    }]

    Returns: {
        cluster_labels: [0, 1, 2, ...],   # 每筆交易的群標籤
        cluster_stats: [{cluster_id, avg_mfe, avg_mae, avg_pnl, count, quality}],
        good_cluster_id: int,              # 好交易的 cluster id
        bad_cluster_id: int,               # 差交易的 cluster id
    }
    """
    from sklearn.cluster import KMeans

    if len(trades) < n_clusters * 3:
        return {"error": "insufficient_data", "min_trades_needed": n_clusters * 3}

    df = pd.DataFrame(trades)

    # 確認必要欄位
    required = ["max_favorable_pct", "max_adverse_pct"]
    for col in required:
        if col not in df.columns:
            return {"error": f"missing_column: {col}"}
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=required)
    if len(df) < n_clusters * 3:
        return {"error": "insufficient_valid_data"}

    # KMeans 分群（MFE 高 + MAE 低 = 好交易）
    X = df[required].values
    km = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = km.fit_predict(X)
    df["cluster"] = labels

    # 每群統計
    cluster_stats = []
    for cid in range(n_clusters):
        mask = df["cluster"] == cid
        subset = df[mask]
        avg_mfe = float(subset["max_favorable_pct"].mean())
        avg_mae = float(subset["max_adverse_pct"].mean())
        avg_pnl = float(subset["trade_pnl_pct"].mean()) if "trade_pnl_pct" in df.columns else None
        # 品質 = MFE / |MAE|，越高越好
        quality = avg_mfe / max(abs(avg_mae), 0.001)
        cluster_stats.append({
            "cluster_id": cid,
            "avg_mfe": round(avg_mfe, 4),
            "avg_mae": round(avg_mae, 4),
            "avg_pnl": round(avg_pnl, 4) if avg_pnl is not None else None,
            "count": int(mask.sum()),
            "quality": round(quality, 4),
        })

    # 找好/差群
    sorted_clusters = sorted(cluster_stats, key=lambda x: x["quality"], reverse=True)
    good_cluster_id = sorted_clusters[0]["cluster_id"]
    bad_cluster_id = sorted_clusters[-1]["cluster_id"]

    return {
        "cluster_labels": labels.tolist(),
        "cluster_stats": cluster_stats,
        "good_cluster_id": good_cluster_id,
        "bad_cluster_id": bad_cluster_id,
    }


def learn_trade_quality_rules(
    trades: list[dict],
    feature_cols: list[str],
    cluster_result: dict,
) -> dict:
    """
    用 DecisionTree 學習什麼因子區分好/壞交易

    Returns: {
        rules: [{feature, threshold, direction, importance}],
        feature_importance: {feature_name: importance_score},
        tree_accuracy: float,
    }
    """
    from sklearn.tree import DecisionTreeClassifier

    if "error" in cluster_result:
        return {"error": cluster_result["error"]}

    df = pd.DataFrame(trades)
    labels = cluster_result["cluster_labels"]
    good_id = cluster_result["good_cluster_id"]

    # 二分類：好交易 vs 其他
    y = np.array([1 if l == good_id else 0 for l in labels])

    available = [c for c in feature_cols if c in df.columns]
    if not available:
        return {"error": "no_feature_columns_available"}

    X = df[available].values
    # 處理 NaN
    from numpy import nan_to_num
    X = nan_to_num(X, nan=0.0)

    if len(X) < 10 or len(set(y)) < 2:
        return {"error": "insufficient_data_for_tree"}

    # 淺層 DecisionTree（避免過擬合）
    tree = DecisionTreeClassifier(max_depth=4, min_samples_leaf=5, random_state=42)
    tree.fit(X, y)

    # 特徵重要性
    importances = dict(zip(available, tree.feature_importances_.tolist()))
    # 只保留 importance > 0.01 的
    importances = {k: round(v, 4) for k, v in importances.items() if v > 0.01}

    # 提取簡易規則（top splits）
    rules = []
    tree_ = tree.tree_
    for node_id in range(tree_.node_count):
        if tree_.feature[node_id] != -2:  # -2 = leaf
            feat_idx = tree_.feature[node_id]
            threshold = tree_.threshold[node_id]
            rules.append({
                "feature": available[feat_idx],
                "threshold": round(float(threshold), 4),
                "importance": round(float(tree.feature_importances_[feat_idx]), 4),
            })

    # 排序去重
    seen = set()
    unique_rules = []
    for r in sorted(rules, key=lambda x: x["importance"], reverse=True):
        if r["feature"] not in seen:
            unique_rules.append(r)
            seen.add(r["feature"])

    return {
        "rules": unique_rules[:5],  # top 5 rules
        "feature_importance": importances,
        "tree_accuracy": round(float(tree.score(X, y)), 4),
        "good_trade_count": int(y.sum()),
        "total_trades": len(y),
    }


def compute_trade_quality_score(
    candidate: dict,
    rules: list[dict],
    feature_importance: dict,
) -> float:
    """
    用 DecisionTree 規則對候選股評分（0-1）

    candidate: {feature_name: value, ...}
    rules: 從 learn_trade_quality_rules 得到的規則
    feature_importance: {feature_name: weight}

    Returns: 0.0~1.0 品質分數
    """
    if not rules or not feature_importance:
        return 0.5  # 無規則時給中性分

    score = 0.0
    total_weight = 0.0

    for rule in rules:
        feat = rule["feature"]
        threshold = rule["threshold"]
        weight = feature_importance.get(feat, 0.01)

        val = candidate.get(feat)
        if val is None:
            continue

        # 規則：好交易傾向在 threshold 哪一邊
        # 簡化：用 threshold 判定，>threshold → 偏好
        if float(val) > threshold:
            score += weight
        total_weight += weight

    return round(score / total_weight, 4) if total_weight > 0 else 0.5
