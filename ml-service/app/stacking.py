"""
stacking.py — Stacking Meta-Learner（Layer 2 Ensemble）

架構：
  Level 0：10 個基礎模型各自輸出 [up_prob, forecast_pct, confidence]
  Level 1：Logistic Regression（L2）學習最佳組合方式

優點（vs 加權投票）：
  - 能學到「當 KalmanFilter 和 XGBoost 同時看漲但 LightGBM 看跌時，
    過去結果是什麼」這種交叉效應
  - 動態捕捉模型間的互補與衝突模式
  - 比固定權重更能適應不同市況

訓練策略：OOF（Out-Of-Fold）時序交叉驗證
  - 避免 data leakage（Level 0 模型不能看到 Level 1 的訓練資料）
  - 4 個 expanding window folds
  - 每次 retrain 時重新訓練 meta-learner
  - 儲存至 GCS，predict 時載入
"""
import numpy as np
import json
import io
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ── 模型順序（固定，確保 meta-features 的欄位順序一致）────────────────────────
MODEL_ORDER = [
    "KalmanFilter", "DLinear", "MarkovSwitching", "PatchTST", "Chronos",
    "XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer",
]
META_FEATURE_DIM = len(MODEL_ORDER) * 3   # 每個模型 3 個特徵：up_prob, |pct|, confidence


# ── Meta-Feature 建構 ─────────────────────────────────────────────────────────
def build_meta_features(predictions: list) -> np.ndarray:
    """
    把 9 個模型的 ModelPrediction 壓縮成 meta-feature 向量
    每個模型：[up_prob, normalized_|forecast_pct|, confidence]
    缺失的模型填 [0.5, 0.0, 0.5]（中立值）
    """
    pred_map = {p.model_name: p for p in predictions}
    meta = []
    for name in MODEL_ORDER:
        p = pred_map.get(name)
        if p is None:
            meta.extend([0.5, 0.0, 0.5])
        else:
            up_prob = p.confidence if p.direction == "up" else (1.0 - p.confidence)
            pct_norm = min(abs(p.forecast_pct) * 20, 1.0)  # 5% 漲跌對應 1.0
            meta.extend([up_prob, pct_norm, p.confidence])
    return np.array(meta, dtype=float)


# ── OOF 訓練 ──────────────────────────────────────────────────────────────────
def train_meta_learner_oof(
    X: np.ndarray,
    y: np.ndarray,
    prices: np.ndarray,
    feature_names: list,
    stock_id: int,
) -> Optional[dict]:
    """
    用 OOF 時序交叉驗證訓練 meta-learner。
    X, y：特徵矩陣和標籤（來自 get_features()）
    prices：完整收盤價序列
    回傳 {"model": LR, "scaler": StandardScaler} 或 None
    """
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    n = len(X)
    if n < 80:
        logger.info(f"[Stacking] 樣本不足（{n}），跳過 OOF 訓練")
        return None

    # ── 延遲 import，避免 loop 外的 import 失敗整個模組 ─────────────────────
    try:
        from xgboost import XGBClassifier
        from catboost import CatBoostClassifier
        from sklearn.ensemble import ExtraTreesClassifier
        from .models import run_kalman_filter, run_dlinear
    except ImportError as e:
        logger.warning(f"[Stacking] import 失敗: {e}")
        return None

    n_folds    = 4
    fold_size  = n // (n_folds + 1)
    meta_X_all, meta_y_all = [], []

    for fold in range(n_folds):
        train_end = fold_size * (fold + 1)
        val_end   = min(train_end + fold_size, n)
        if val_end - train_end < 5 or train_end < 30:
            continue

        X_tr, y_tr = X[:train_end], y[:train_end]
        X_val       = X[train_end:val_end]
        y_val       = y[train_end:val_end]

        # ── 訓練 Level-0 特徵模型（輕量版，用於 OOF）────────────────────────
        fold_models = {}
        _simple_kwargs = dict(random_state=42, n_jobs=-1)

        try:
            m = XGBClassifier(n_estimators=80, max_depth=4, learning_rate=0.05,
                              use_label_encoder=False, eval_metric="logloss",
                              random_state=42, verbosity=0)
            m.fit(X_tr, y_tr); fold_models["XGBoost"] = m
        except Exception: pass

        try:
            m = CatBoostClassifier(iterations=80, depth=4, learning_rate=0.05,
                                   loss_function="Logloss", random_seed=42, verbose=0)
            m.fit(X_tr, y_tr); fold_models["CatBoost"] = m
        except Exception: pass

        try:
            m = ExtraTreesClassifier(n_estimators=80, max_depth=5, **_simple_kwargs)
            m.fit(X_tr, y_tr); fold_models["ExtraTrees"] = m
        except Exception: pass

        # LightGBM：輕量版 OOF
        try:
            import lightgbm as lgb
            m = lgb.LGBMClassifier(
                n_estimators=80, max_depth=4, learning_rate=0.05,
                num_leaves=15, class_weight="balanced",
                random_state=42, verbose=-1,
            )
            m.fit(X_tr, y_tr); fold_models["LightGBM"] = m
        except Exception: pass

        # ── 對每個驗證樣本建立 meta-features ────────────────────────────────
        from .models import ModelPrediction
        for i in range(len(X_val)):
            fold_preds = []

            # 特徵模型：直接從已訓練模型取機率
            for name, mdl in fold_models.items():
                try:
                    proba = mdl.predict_proba(X_val[i:i+1])[0]
                    up_p  = float(proba[1])
                    fold_preds.append(ModelPrediction(
                        model_name=name,
                        direction="up" if up_p > 0.5 else "down",
                        confidence=max(up_p, 1 - up_p),
                        forecast_pct=(up_p - 0.5) * 0.1,
                        direction_accuracy=0.5,
                    ))
                except Exception:
                    pass

            # 純價格模型：用此時點之前的價格序列
            price_idx = int(len(prices) * train_end / n) + i
            p_seg = prices[:max(40, price_idx)]
            for fn, fname in [
                (run_kalman_filter, "KalmanFilter"),
                (run_dlinear,       "DLinear"),
            ]:
                try:
                    fold_preds.append(fn(p_seg, horizon=14))
                except Exception:
                    pass

            meta_X_all.append(build_meta_features(fold_preds))
            meta_y_all.append(int(y_val[i]))

    if len(meta_X_all) < 20:
        logger.info(f"[Stacking] OOF 樣本太少（{len(meta_X_all)}），跳過")
        return None

    meta_X = np.array(meta_X_all)
    meta_y = np.array(meta_y_all)

    # H6 fix: temporal 80/20 split for honest OOF evaluation
    split = int(len(meta_X) * 0.8)
    meta_X_train, meta_X_eval = meta_X[:split], meta_X[split:]
    meta_y_train, meta_y_eval = meta_y[:split], meta_y[split:]

    scaler_eval = StandardScaler()
    meta_Xs_train = scaler_eval.fit_transform(meta_X_train)
    meta_Xs_eval  = scaler_eval.transform(meta_X_eval)

    # C=1.0（10 模型 × 3 特徵 = 30 維輸入）
    # lbfgs solver 在中等維度比 liblinear 收斂更穩定
    # max_iter=500 確保收斂
    meta_model = LogisticRegression(
        penalty="l2", C=1.0, solver="lbfgs",
        max_iter=500, random_state=42,
    )
    meta_model.fit(meta_Xs_train, meta_y_train)
    oof_acc = meta_model.score(meta_Xs_eval, meta_y_eval)
    logger.info(f"[Stacking] Meta-learner OOF holdout acc={oof_acc:.3f} (eval={len(meta_y_eval)}, train={len(meta_y_train)})")

    # Retrain on full data for production use
    scaler    = StandardScaler()
    meta_Xs   = scaler.fit_transform(meta_X)
    meta_model.fit(meta_Xs, meta_y)
    logger.info(f"[Stacking] Meta-learner 已用全量 {len(meta_y)} 筆重新訓練")
    return {"model": meta_model, "scaler": scaler}


# ── 推論 ──────────────────────────────────────────────────────────────────────
def meta_predict(predictions: list, bundle: dict | None) -> tuple[str | None, float | None]:
    """
    用訓練好的 meta-learner 輸出最終方向和機率。
    回傳 (direction, up_probability) 或 (None, None) 表示 fallback
    """
    if bundle is None:
        return None, None
    try:
        feat   = build_meta_features(predictions).reshape(1, -1)
        scaled = bundle["scaler"].transform(feat)
        proba  = bundle["model"].predict_proba(scaled)[0]
        up_p   = float(proba[1])
        return ("up" if up_p > 0.5 else "down"), max(up_p, 1 - up_p)
    except Exception as e:
        logger.warning(f"[Stacking] meta_predict 失敗: {e}")
        return None, None


# ── GCS 持久化 ────────────────────────────────────────────────────────────────
def save_meta_learner(bundle: dict, stock_id: int) -> bool:
    from .model_store import _get_bucket
    try:
        import joblib
        bucket = _get_bucket()
        if not bucket:
            return False
        buf = io.BytesIO()
        joblib.dump(bundle, buf); buf.seek(0)
        bucket.blob(f"{stock_id}/stacking_meta.joblib").upload_from_file(buf)
        import datetime as _dt
        meta = {"stock_id": stock_id,
                "trained_at": _dt.datetime.utcnow().isoformat(),
                "meta_feature_dim": META_FEATURE_DIM}
        bucket.blob(f"{stock_id}/metadata_stacking.json").upload_from_string(
            json.dumps(meta), content_type="application/json")
        logger.info(f"[Stacking] stock {stock_id} meta-learner 已存入 GCS")
        return True
    except Exception as e:
        logger.error(f"[Stacking] GCS save 失敗: {e}")
        return False


def load_meta_learner(stock_id: int) -> Optional[dict]:
    from .model_store import _get_bucket, is_model_fresh
    try:
        import joblib
        bucket = _get_bucket()
        if not bucket:
            return None
        meta_blob = bucket.blob(f"{stock_id}/metadata_stacking.json")
        if not meta_blob.exists():
            return None
        meta = json.loads(meta_blob.download_as_text())
        if not is_model_fresh({"trained_at": meta.get("trained_at", "")}, max_age_days=10):
            return None
        model_blob = bucket.blob(f"{stock_id}/stacking_meta.joblib")
        if not model_blob.exists():
            return None
        buf = io.BytesIO()
        model_blob.download_to_file(buf); buf.seek(0)
        bundle = joblib.load(buf)
        logger.info(f"[Stacking] 已從 GCS 載入 stock {stock_id} meta-learner")
        return bundle
    except Exception as e:
        logger.warning(f"[Stacking] GCS load 失敗: {e}")
        return None
