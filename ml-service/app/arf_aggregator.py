"""
Adaptive Random Forest aggregation layer.

Inputs are the 8 active alpha prediction models only. State-space models
(KalmanFilter / MarkovSwitching) are regime/risk overlays, not alpha peers.

Feature layout: 8 direction flags + 8 confidence values + 8 recent accuracy
values + 3 market context fields = 27 dimensions.
"""
from __future__ import annotations

import os
import pickle
from typing import Optional, TYPE_CHECKING
import numpy as np

from .model_pool import ALPHA_PREDICTION_MODELS

if TYPE_CHECKING:
    from .models import ModelPrediction

# ── 常數 ──────────────────────────────────────────────────────────────────────

# 只包含 base prediction models（不含 DoNothing — 它沒有 prediction 輸出）
BASE_MODEL_NAMES = list(ALPHA_PREDICTION_MODELS)

CONTEXT_DIM      = 3    # hmm_regime_norm, garch_vol_norm, market_risk_score
FEATURE_DIM      = len(BASE_MODEL_NAMES) * 3 + CONTEXT_DIM
ARF_STATE_DIR    = "/tmp/arf_state"
ARF_STATE_FILE   = "arf_state.pkl"
MIN_OBS_TO_TRUST = 50   # 至少 50 筆驗證樣本後才信任 ARF 輸出（靜態預設值）

# P1#10: Dynamic warm-up threshold based on volatility
MIN_OBS_HIGH_VOL = 30   # high vol → 快速適應，少量樣本就信任
MIN_OBS_LOW_VOL = 80    # low vol → 穩定為主，需要更多樣本


def get_dynamic_min_obs(garch_vol_norm: float = 0.4,
                        adaptive_params: dict | None = None) -> int:
    """P1#10: ARF warm-up threshold adapts to market volatility."""
    _ap = adaptive_params or {}
    min_obs_default = int(_ap.get("arf_min_obs_to_trust", MIN_OBS_TO_TRUST))
    min_obs_high = int(_ap.get("arf_min_obs_high_vol", MIN_OBS_HIGH_VOL))
    min_obs_low = int(_ap.get("arf_min_obs_low_vol", MIN_OBS_LOW_VOL))
    vol_thresh_high = float(_ap.get("arf_vol_thresh_high", 1.0))
    vol_thresh_low = float(_ap.get("arf_vol_thresh_low", 0.3))

    # garch_vol_norm: 0~2 (0=calm, 1=normal, 2=volatile)
    if garch_vol_norm > vol_thresh_high:
        return min_obs_high   # high vol → fast adapt
    elif garch_vol_norm < vol_thresh_low:
        return min_obs_low    # low vol → stable
    else:
        # Linear interpolation between min_obs_low and min_obs_high
        t = (garch_vol_norm - vol_thresh_low) / max(vol_thresh_high - vol_thresh_low, 0.01)  # 0→1
        return int(min_obs_low + t * (min_obs_high - min_obs_low))


# ── 特徵建構 ──────────────────────────────────────────────────────────────────

def build_arf_features(
    predictions: list,               # list[ModelPrediction]
    hmm_regime_norm: float = 0.5,    # 已歸一化 [0,1]
    garch_vol_norm: float  = 0.4,    # 已歸一化 [0,2]
    market_risk_score: float = 0.5,  # [0,1]
) -> np.ndarray:
    """
    將 8 個 alpha base model 的預測 + 市場情境轉成 ARF 特徵向量（27 維）。
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
    """Persist ARF state to GCS and mirror locally for diagnostics."""
    os.makedirs(dir_path, exist_ok=True)
    path = os.path.join(dir_path, ARF_STATE_FILE)
    with open(path, "wb") as f:
        pickle.dump(arf, f, protocol=pickle.HIGHEST_PROTOCOL)
    if not _save_arf_gcs(arf):
        raise RuntimeError("ARF GCS save failed")
    return path


def load_arf(dir_path: str = ARF_STATE_DIR, *, allow_fresh: bool = False) -> ARFAggregator:
    """Load ARF state from GCS.

    Online update paths must use the default artifact-required behavior so a
    missing durable state cannot be replaced by a fresh model. Prediction paths
    may pass allow_fresh=True to get a no-op, not-warmed-up ARF for transparent
    correction without saving it.
    """
    gcs_arf = _load_arf_gcs()
    if gcs_arf is not None:
        return gcs_arf
    if allow_fresh:
        return ARFAggregator()
    raise FileNotFoundError("ARF state missing in GCS: meta/arf_state.pkl")


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
    adaptive_params: dict | None = None,
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
    _ap = adaptive_params or {}
    conf_boost      = float(_ap.get("arf_conf_boost", 0.05))
    conf_mid_penalty = float(_ap.get("arf_conf_mid_penalty", 0.10))
    conf_strong_penalty = float(_ap.get("arf_conf_strong_penalty", 0.20))
    arf_strong_confirm_thresh = float(_ap.get("arf_strong_confirm_thresh", 0.25))

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
        if arf_strength > arf_strong_confirm_thresh:
            new_conf = min(0.95, ensemble_confidence + conf_boost)
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
        new_conf   = max(0.0, ensemble_confidence - conf_mid_penalty)
        new_is_up  = ensemble_is_up if downgraded != "HOLD" else ensemble_is_up
        return new_is_up, new_conf, downgraded, arf_prob
    else:
        # 強反向：建議觀望
        return ensemble_is_up, max(0.0, ensemble_confidence - conf_strong_penalty), "HOLD", arf_prob
