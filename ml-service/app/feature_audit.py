"""
feature_audit.py — 特徵重要性審計 + 模型貢獻追蹤

Weekly pipeline：
1. Permutation Feature Importance（比 SHAP 快，適合定期執行）
2. Per-arm LinUCB weight 週報
3. 低貢獻 feature flag（不自動剔除，人工決定）

呼叫方：main.py POST /feature-audit 或 weekly cron
結果：回傳 JSON，由 Worker 存入 D1 feature_importance / model_weights_weekly
"""
from __future__ import annotations

import numpy as np
from typing import Optional
from datetime import datetime


def compute_permutation_importance(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    n_repeats: int = 5,
    random_state: int = 42,
) -> list[dict]:
    """
    Permutation Feature Importance：打亂每個特徵，看準確率掉多少。
    不依賴特定模型，用 LightGBM 作為 proxy（快 + 穩定）。

    Returns: [{name, importance_mean, importance_std, rank}] sorted by importance desc
    """
    if len(X) < 50 or len(feature_names) == 0:
        return []

    try:
        import lightgbm as lgb
        from sklearn.inspection import permutation_importance
        from sklearn.model_selection import train_test_split

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.3, shuffle=False  # 時序不打亂
        )

        model = lgb.LGBMClassifier(
            n_estimators=100, max_depth=5, learning_rate=0.1,
            verbose=-1, n_jobs=-1, random_state=random_state,
        )
        model.fit(X_train, y_train)

        result = permutation_importance(
            model, X_test, y_test,
            n_repeats=n_repeats,
            random_state=random_state,
            scoring="accuracy",
        )

        importance_list = []
        for i, name in enumerate(feature_names):
            importance_list.append({
                "name": name,
                "importance_mean": round(float(result.importances_mean[i]), 6),
                "importance_std": round(float(result.importances_std[i]), 6),
            })

        # Sort by importance desc, add rank
        importance_list.sort(key=lambda x: x["importance_mean"], reverse=True)
        for rank, item in enumerate(importance_list, 1):
            item["rank"] = rank

        return importance_list

    except Exception as e:
        print(f"[FeatureAudit] Permutation importance failed: {e}")
        return []


def compute_linucb_arm_weights(
    bandit_state_dir: str = "/tmp/linucb_bandit",
) -> dict:
    """
    從 LinUCB state 取出各 arm 的統計資訊：
    - obs_count per arm
    - neutral context θ（中性市場下的期望 reward）
    - 是否 warmed up
    """
    try:
        from .linucb_bandit import load_bandit, ARM_NAMES
        bandit = load_bandit(bandit_state_dir)
        stats = bandit.stats_summary()

        # 加入 DoNothing arm 的相對位置
        obs_per_arm = stats.get("obs_per_arm", {})
        theta_per_arm = stats.get("neutral_theta", {})

        return {
            "date": datetime.utcnow().strftime("%Y-%m-%d"),
            "total_observations": stats["total_observations"],
            "is_warmed_up": stats["is_warmed_up"],
            "arms": [
                {
                    "name": name,
                    "observations": obs_per_arm.get(name, 0),
                    "neutral_theta": theta_per_arm.get(name, 0.0),
                    "is_donothing": name == "DoNothing",
                }
                for name in ARM_NAMES
            ],
        }
    except Exception as e:
        print(f"[FeatureAudit] LinUCB stats failed: {e}")
        return {"error": str(e)}


def run_feature_audit(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
) -> dict:
    """
    完整審計：Permutation Importance + LinUCB arm weights。
    回傳結構化 JSON，由 Worker 存入 D1。
    """
    importance = compute_permutation_importance(X, y, feature_names)
    arm_weights = compute_linucb_arm_weights()

    # Flag 低貢獻特徵（importance_mean < 0.001）
    low_contrib = [f for f in importance if f["importance_mean"] < 0.001]

    return {
        "audit_date": datetime.utcnow().isoformat() + "Z",
        "feature_count": len(feature_names),
        "sample_count": len(X),
        "feature_importance": importance,
        "low_contribution_features": [f["name"] for f in low_contrib],
        "low_contribution_count": len(low_contrib),
        "linucb_arm_weights": arm_weights,
    }
