"""
arf_aggregator.py — Adaptive Random Forest 聚合層（第 11 模型：在線增量聚合）

定位：weighted_vote（LinUCB 加權投票）之後的第二道聚合，
      利用 River 的 ARF + ADWIN Drift Detection 持續線上學習，
      學會「在什麼樣的 10 模型輸出組合下，最終方向更可能是哪一邊」。

兩層架構：
  Layer 1 — LinUCB Bandit：根據市場情境調整各模型的信任權重（路由層）
  Layer 2 — ARF（本檔）  ：把 10 個模型的輸出向量做增量分類，輸出最終方向機率（聚合層）

特徵向量（33 維，不含 DoNothing arm — 它沒有 prediction 輸出）：
  [0:10]  direction_numeric  — 1=up / 0=down，各 base model
  [10:20] confidence         — 各 base model 預測信心（0~1）
  [20:30] direction_accuracy — 各 base model 過去準確率（0~1）
  [30]    hmm_regime_norm    — HMM 狀態歸一化 [0,1]
  [31]    garch_vol_norm     — GARCH 波動率 [0,2]
  [32]    market_risk_score  — 市場風險分數 [0,1]

目標（y）：5 日後實際方向（1=up / 0=down）
學習時機：auto-trade cron 驗證結果後呼叫 arf_update()
輸出：P(up)（0~1），整合進 ensemble 最終訊號

持久化：pickle 格式，存放在 /tmp/arf_state/arf_state.pkl
"""
from __future__ import annotations

import os
import pickle
from typing import Optional, TYPE_CHECKING
import numpy as np

if TYPE_CHECKING:
    from .models import ModelPrediction

# ── 常數 ──────────────────────────────────────────────────────────────────────

# 只包含 base prediction models（不含 DoNothing — 它沒有 prediction 輸出）
BASE_MODEL_NAMES = [
    "KalmanFilter", "DLinear", "MarkovSwitching", "PatchTST", "Chronos",
    "XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer",
]

CONTEXT_DIM      = 3    # hmm_regime_norm, garch_vol_norm, market_risk_score
FEATURE_DIM      = len(BASE_MODEL_NAMES) * 3 + CONTEXT_DIM  # 33（DoNothing 不影響 ARF 特徵）
ARF_STATE_DIR    = "/tmp/arf_state"
ARF_STATE_FILE   = "arf_state.pkl"
MIN_OBS_TO_TRUST = 50   # 至少 50 筆驗證樣本後才信任 ARF 輸出


# ── 特徵建構 ──────────────────────────────────────────────────────────────────

def build_arf_features(
    predictions: list,               # list[ModelPrediction]
    hmm_regime_norm: float = 0.5,    # 已歸一化 [0,1]
    garch_vol_norm: float  = 0.4,    # 已歸一化 [0,2]
    market_risk_score: float = 0.5,  # [0,1]
) -> np.ndarray:
    """
    將 10 個 base model 的預測 + 市場情境轉成 ARF 特徵向量（33 維）。
    若某 model 預測缺失，使用中性填補（方向=0.5，信心=0，準確率=0.5）。
    """
    pred_map = {p.model_name: p for p in predictions}

    direction_vec  = []
    confidence_vec = []
    accuracy_vec   = []

    for name in BASE_MODEL_NAMES:
        p = pred_map.get(name)
        if p is not None:
            direction_vec.append(1.0 if p.direction == "up" else 0.0)
            confidence_vec.append(float(np.clip(p.confidence, 0.0, 1.0)))
            accuracy_vec.append(float(np.clip(p.direction_accuracy, 0.0, 1.0)))
        else:
            direction_vec.append(0.5)   # 中性
            confidence_vec.append(0.0)
            accuracy_vec.append(0.5)

    context = [
        float(np.clip(hmm_regime_norm,    0.0, 1.0)),
        float(np.clip(garch_vol_norm,     0.0, 2.0)),
        float(np.clip(market_risk_score,  0.0, 1.0)),
    ]

    features = direction_vec + confidence_vec + accuracy_vec + context
    return np.array(features, dtype=np.float64)


def _to_river_dict(features: np.ndarray) -> dict:
    """River 要求輸入為 {feature_name: value} dict"""
    return {f"f{i}": float(v) for i, v in enumerate(features)}


# ── ARF Aggregator ────────────────────────────────────────────────────────────

class ARFAggregator:
    """
    包裝 River AdaptiveRandomForestClassifier，提供：
    - predict_proba()   → P(up)，用於修正 weighted_vote 結果
    - update()          → 線上學習，驗證結果後呼叫
    - is_warmed_up()    → 控制是否啟用 ARF 修正

    River 不在標準 requirements 中，若未安裝則 _available=False，
    ARF 靜默退化為「不影響任何訊號」，不拋出例外。
    """

    def __init__(self) -> None:
        self._arf = None
        self._available = False
        self.n_trained: int = 0
        self._try_init()

    def _try_init(self) -> None:
        try:
            from river import drift
            # river >=0.17 moved ARF to river.forest.ARFClassifier
            try:
                from river.forest import ARFClassifier
            except ImportError:
                from river.ensemble import AdaptiveRandomForestClassifier as ARFClassifier
            self._arf = ARFClassifier(
                n_models=10,
                drift_detector=drift.ADWIN(),
                warning_detector=drift.ADWIN(delta=0.05),
                seed=42,
            )
            self._available = True
        except (ImportError, AttributeError):
            pass   # River 未安裝或 API 不相容，靜默退化

    # ── 對外介面 ──────────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        return self._available

    def is_warmed_up(self, min_obs: int = MIN_OBS_TO_TRUST) -> bool:
        return self._available and self.n_trained >= min_obs

    def predict_proba(self, features: np.ndarray) -> float:
        """
        回傳 P(direction=up)（0~1）。
        未 warm-up 時回傳 0.5（中性，對訊號無影響）。
        """
        if not self.is_warmed_up():
            return 0.5
        try:
            proba = self._arf.predict_proba_one(_to_river_dict(features))
            return float(proba.get(1, 0.5))
        except Exception as e:
            print(f"[ARF] predict_proba failed: {e}")
            return 0.5

    def update(self, features: np.ndarray, actual_up: bool) -> None:
        """
        接收驗證結果，線上更新 ARF。
        actual_up: True = 5 日後股價確實上漲，False = 下跌。
        ADWIN 會自動偵測 concept drift 並重置部分子樹。
        """
        if not self._available or self._arf is None:
            return
        try:
            y = 1 if actual_up else 0
            self._arf.learn_one(_to_river_dict(features), y)
            self.n_trained += 1
        except Exception as e:
            print(f"[ARF] update failed: {e}")

    def stats_summary(self) -> dict:
        return {
            "n_trained":        self.n_trained,
            "is_warmed_up":     self.is_warmed_up(),
            "min_obs_to_trust": MIN_OBS_TO_TRUST,
            "available":        self._available,
        }


# ── 持久化 ────────────────────────────────────────────────────────────────────

def save_arf(arf: ARFAggregator, dir_path: str = ARF_STATE_DIR) -> str:
    """存檔：本地 + GCS 持久化"""
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, ARF_STATE_FILE)
    with open(path, "wb") as f:
        pickle.dump(arf, f, protocol=pickle.HIGHEST_PROTOCOL)
    # #3 GCS 持久化
    _save_arf_gcs(arf)
    return path


def load_arf(dir_path: str = ARF_STATE_DIR) -> ARFAggregator:
    """GCS 優先 → 本地 fallback → 全新 ARF"""
    # #3 先嘗試 GCS
    gcs_arf = _load_arf_gcs()
    if gcs_arf is not None:
        return gcs_arf
    # 本地 fallback
    path = os.path.join(dir_path, ARF_STATE_FILE)
    if not os.path.exists(path):
        return ARFAggregator()
    try:
        with open(path, "rb") as f:
            arf = pickle.load(f)
        if not isinstance(arf, ARFAggregator):
            return ARFAggregator()
        if not arf._available:
            arf._try_init()
        return arf
    except Exception as e:
        print(f"[ARF] load failed ({e}), starting fresh")
        return ARFAggregator()


def _save_arf_gcs(arf: ARFAggregator) -> bool:
    """#3 ARF GCS 持久化"""
    try:
        import io
        from .model_store import _get_bucket
        bucket = _get_bucket()
        if bucket is None:
            return False
        buf = io.BytesIO()
        pickle.dump(arf, buf, protocol=pickle.HIGHEST_PROTOCOL)
        buf.seek(0)
        bucket.blob("meta/arf_state.pkl").upload_from_file(
            buf, content_type="application/octet-stream")
        print(f"[ARF] saved to GCS (n_trained={arf.n_trained})")
        return True
    except Exception as e:
        print(f"[ARF] GCS save failed: {e}")
        return False


def _load_arf_gcs() -> Optional[ARFAggregator]:
    """#3 從 GCS 載入 ARF 狀態"""
    try:
        import io
        from .model_store import _get_bucket
        bucket = _get_bucket()
        if bucket is None:
            return None
        blob = bucket.blob("meta/arf_state.pkl")
        if not blob.exists():
            return None
        buf = io.BytesIO()
        blob.download_to_file(buf)
        buf.seek(0)
        arf = pickle.load(buf)
        if not isinstance(arf, ARFAggregator):
            return None
        if not arf._available:
            arf._try_init()
        print(f"[ARF] loaded from GCS (n_trained={arf.n_trained})")
        return arf
    except Exception as e:
        print(f"[ARF] GCS load failed: {e}")
        return None


# ── 主要對外介面（供 main.py 呼叫）──────────────────────────────────────────

def apply_arf_correction(
    arf: ARFAggregator,
    arf_features: np.ndarray,
    ensemble_is_up: bool,
    ensemble_confidence: float,
    ensemble_signal: str,
) -> tuple[bool, float, str, float]:
    """
    將 ARF 的 P(up) 與 weighted_vote 結果融合，回傳修正後的：
    (is_up, confidence, signal, arf_prob)

    融合策略（保守原則：ARF 只能降級，不能憑空創造訊號）：
    - ARF 未 warm-up   → 完全透明，不改變任何輸出
    - ARF 同向強烈確認 → confidence 小幅提升（+5%）
    - ARF 同向          → 維持原訊號
    - ARF 弱反向        → 訊號降一級（STRONG→BUY, BUY→HOLD, SELL→HOLD）
    - ARF 強烈反向      → 直接輸出 HOLD（建議觀望）
    """
    arf_prob = arf.predict_proba(arf_features)

    if not arf.is_warmed_up():
        return ensemble_is_up, ensemble_confidence, ensemble_signal, arf_prob

    arf_is_up    = arf_prob > 0.5
    arf_strength = abs(arf_prob - 0.5)   # 0 = 中性, 0.5 = 極端

    DOWNGRADE_MAP = {
        "STRONG_BUY":  "BUY",
        "BUY":         "HOLD",
        "STRONG_SELL": "SELL",
        "SELL":        "HOLD",
        "HOLD":        "HOLD",
        "NO_SIGNAL":   "NO_SIGNAL",
    }

    if arf_is_up == ensemble_is_up:
        # 同向：强烈確認時小幅提升信心
        if arf_strength > 0.25:
            new_conf = min(0.95, ensemble_confidence + 0.05)
        else:
            new_conf = ensemble_confidence
        return ensemble_is_up, new_conf, ensemble_signal, arf_prob

    # 反向
    if arf_strength < 0.15:
        # 弱反向：維持原訊號（ARF 不確定）
        return ensemble_is_up, ensemble_confidence, ensemble_signal, arf_prob
    elif arf_strength < 0.30:
        # 中反向：降一級
        downgraded = DOWNGRADE_MAP.get(ensemble_signal, ensemble_signal)
        new_conf   = max(0.0, ensemble_confidence - 0.10)
        new_is_up  = ensemble_is_up if downgraded != "HOLD" else ensemble_is_up
        return new_is_up, new_conf, downgraded, arf_prob
    else:
        # 強反向：建議觀望
        return ensemble_is_up, max(0.0, ensemble_confidence - 0.20), "HOLD", arf_prob
