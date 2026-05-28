"""
regime.py — HMM 市場狀態偵測器
使用 hmmlearn GaussianHMM 偵測當前市場 regime（牛市/熊市/震盪/危機）
根據 regime 動態調整 ensemble 各模型的投票權重

運作流程：
  1. 每週重訓時，用 market_env history 訓練 HMM，用 BIC 自動選擇 n_components
  2. 將 HMM 隱藏狀態映射到語意 regime（根據各狀態的平均報酬和波動率）
  3. predict 時，輸入當前市況特徵，偵測 regime，回傳各模型的權重乘數
"""
import numpy as np
import json
import io
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── 各 Regime 的模型權重調整方案 ──────────────────────────────────────────────
# 0 = 低波動牛市：趨勢動能強，純價格模型（Kalman, ARIMA）訊號可靠
# 1 = 高波動牛市：籌碼動量驅動，特徵模型（XGB, CatBoost）更準確
# 2 = 震盪整理：訊號雜訊高，整體降信心，收緊共識門檻
# 3 = 熊市危機：所有模型保守，GP 寬區間反而誠實
DEFAULT_REGIME_CONFIG = {
    0: {"label": "低波動牛市", "price_mult": 1.2,  "feature_mult": 1.0,  "consensus_threshold": 0.55},
    1: {"label": "高波動牛市", "price_mult": 0.9,  "feature_mult": 1.25, "consensus_threshold": 0.60},
    2: {"label": "震盪整理",   "price_mult": 0.8,  "feature_mult": 0.85, "consensus_threshold": 0.68},
    3: {"label": "熊市危機",   "price_mult": 0.65, "feature_mult": 0.75, "consensus_threshold": 0.72},
}
REGIME_CONFIG = DEFAULT_REGIME_CONFIG  # runtime alias, overridden by regime_config_override

PRICE_MODEL_NAMES   = {"DLinear", "PatchTST"}
FEATURE_MODEL_NAMES = {"XGBoost", "CatBoost", "ExtraTrees", "LightGBM"}


class RegimeDetector:
    def __init__(self):
        self.model          = None
        self.n_components   = 3
        self.regime_map     = {}   # HMM state index → semantic regime index (0-3)
        self.feature_means  = None
        self.feature_stds   = None
        self._trained       = False

    # ── 訓練 ──────────────────────────────────────────────────────────────────
    def fit(self, features_raw: np.ndarray) -> "RegimeDetector":
        """
        features_raw shape: (n_days, 4)
          col 0: market_return_1d
          col 1: market_return_5d
          col 2: risk_score (0-1)
          col 3: market_bias_20d
        """
        if len(features_raw) < 30:
            logger.warning("[Regime] 資料不足 30 天，跳過訓練")
            return self

        try:
            from hmmlearn import hmm
        except ImportError:
            logger.warning("[Regime] hmmlearn 未安裝，Regime Detection 停用")
            return self

        # 標準化
        self.feature_means = features_raw.mean(axis=0)
        self.feature_stds  = features_raw.std(axis=0) + 1e-8
        features = (features_raw - self.feature_means) / self.feature_stds

        # BIC 選擇最佳 n_components（2~5）
        best_bic, best_n = np.inf, 2
        max_n = min(5, len(features) // 15)
        for n in range(2, max_n + 1):
            try:
                m = hmm.GaussianHMM(
                    n_components=n, covariance_type="full",
                    n_iter=100, random_state=42,
                )
                m.fit(features)
                b = m.bic(features)
                if b < best_bic:
                    best_bic, best_n = b, n
            except Exception:
                pass

        self.n_components = best_n
        self.model = hmm.GaussianHMM(
            n_components=best_n, covariance_type="full",
            n_iter=300, random_state=42,
        )
        self.model.fit(features)

        # 語意映射：根據各狀態的平均報酬 & 波動率分類
        states = self.model.predict(features)
        self.regime_map = self._assign_semantic_regimes(features_raw, states)
        self._trained = True

        labels = [REGIME_CONFIG[self.regime_map.get(s, 1)]["label"] for s in range(best_n)]
        logger.info(f"[Regime] 訓練完成: {best_n} states, BIC={best_bic:.1f}, labels={labels}")
        return self

    def _assign_semantic_regimes(self, features_raw: np.ndarray, states: np.ndarray) -> dict:
        """根據每個 HMM 狀態的統計特徵，映射到語意 regime"""
        state_stats = {}
        for s in range(self.n_components):
            mask = states == s
            if mask.sum() < 3:
                continue
            f = features_raw[mask]
            state_stats[s] = {
                "mean_return": float(f[:, 0].mean()),   # 平均日報酬
                "mean_vol":    float(f[:, 2].mean()),   # 平均風險分數（代理波動率）
                "count":       int(mask.sum()),
            }

        if not state_stats:
            return {0: 1}

        # 按平均報酬降序排列
        ranked = sorted(state_stats.items(), key=lambda x: -x[1]["mean_return"])
        n = len(ranked)

        regime_map = {}
        if n >= 4:
            # 最高報酬 & 低波動 → 0（低波動牛市）
            # 最高報酬 & 高波動 → 1（高波動牛市）
            # 中間 → 2（震盪）
            # 最低報酬 → 3（熊市）
            top_half = sorted(ranked[:n//2+1], key=lambda x: x[1]["mean_vol"])
            for i, (s, _) in enumerate(top_half):
                regime_map[s] = min(i, 1)
            for i, (s, _) in enumerate(ranked[n//2+1:]):
                regime_map[s] = min(2 + i, 3)
        elif n == 3:
            regime_map[ranked[0][0]] = 0   # 最好
            regime_map[ranked[1][0]] = 2   # 中間
            regime_map[ranked[2][0]] = 3   # 最差
        elif n == 2:
            regime_map[ranked[0][0]] = 0
            regime_map[ranked[1][0]] = 3
        else:
            regime_map[ranked[0][0]] = 1

        # 補全遺漏的 state
        for s in range(self.n_components):
            if s not in regime_map:
                regime_map[s] = 1
        return regime_map

    # ── 推論 ──────────────────────────────────────────────────────────────────
    def predict_regime(self, current_features_raw: np.ndarray, regime_config_override: dict | None = None) -> dict:
        """
        輸入當前市況特徵向量（1 行），回傳 regime 資訊 dict。
        regime_config_override: optional KV dict keyed by regime index (int or str),
            values are partial dicts merged on top of DEFAULT_REGIME_CONFIG.
        """
        # Deep merge: override 只覆蓋有給的 key，其餘保留 default
        if regime_config_override:
            effective_config = {}
            for k, v in DEFAULT_REGIME_CONFIG.items():
                override_entry = regime_config_override.get(k) or regime_config_override.get(str(k)) or {}
                effective_config[k] = {**v, **{ok: float(ov) if ok != "label" else ov for ok, ov in override_entry.items()}}
        else:
            effective_config = DEFAULT_REGIME_CONFIG

        default = {
            "regime_index": 1, "hmm_state": -1,
            "label": "未知（使用預設）",
            "weight_multipliers": {},
            "consensus_threshold": 0.60,
        }
        if not self._trained or self.model is None:
            return default

        try:
            f = current_features_raw.reshape(1, -1)
            if self.feature_means is not None:
                f = (f - self.feature_means) / self.feature_stds

            state     = int(self.model.predict(f)[-1])
            reg_idx   = self.regime_map.get(state, 1)
            cfg       = effective_config.get(reg_idx, effective_config[1])

            mults = {}
            for m in PRICE_MODEL_NAMES:
                mults[m] = cfg["price_mult"]
            for m in FEATURE_MODEL_NAMES:
                mults[m] = cfg["feature_mult"]

            return {
                "regime_index":       reg_idx,
                "hmm_state":          state,
                "label":              cfg["label"],
                "weight_multipliers": mults,
                "consensus_threshold": cfg["consensus_threshold"],
            }
        except Exception as e:
            logger.warning(f"[Regime] predict_regime failed: {e}")
            return default

    # ── GCS 持久化 ────────────────────────────────────────────────────────────
    def save_to_gcs(
        self,
        gcs_prefix: str = "market_regime",     # 2026-04-18 #32: walk-forward override
        extra_metadata: Optional[dict] = None,
    ) -> bool:
        """Save trained HMM to GCS.

        Default: `market_regime/hmm_detector.joblib` (production path)
        Walk-forward: `walk_forward/w{id}/hmm_detector.joblib` (window snapshot)
        """
        from .model_store import _get_bucket
        if not self._trained:
            return False
        try:
            import joblib
            bucket = _get_bucket()
            if not bucket:
                return False
            prefix = gcs_prefix.rstrip("/")
            buf = io.BytesIO()
            joblib.dump(self, buf); buf.seek(0)
            bucket.blob(f"{prefix}/hmm_detector.joblib").upload_from_file(buf)
            meta = {
                "n_components": self.n_components,
                "regime_map":   {str(k): v for k, v in self.regime_map.items()},
                "trained_at":   datetime.now(timezone.utc).isoformat(),
                "gcs_prefix":   prefix,
            }
            if extra_metadata:
                meta.update(extra_metadata)
            bucket.blob(f"{prefix}/metadata.json").upload_from_string(
                json.dumps(meta), content_type="application/json")
            logger.info(f"[Regime] 模型已儲存至 GCS: {prefix}")
            return True
        except Exception as e:
            logger.error(f"[Regime] GCS save 失敗: {e}")
            return False

    @classmethod
    def load_from_gcs(
        cls,
        gcs_prefix: str = "market_regime",
        skip_freshness_check: bool = False,
    ) -> Optional["RegimeDetector"]:
        """Load HMM detector from GCS.

        gcs_prefix:           default production path `market_regime`.
                              Walk-forward: `walk_forward/w{id}`.
        skip_freshness_check: walk-forward snapshots are historical, never "fresh";
                              set True to bypass the 9-day freshness gate.
        """
        from .model_store import _get_bucket, is_model_fresh
        try:
            import joblib
            bucket = _get_bucket()
            if not bucket:
                return None
            prefix = gcs_prefix.rstrip("/")
            meta_blob = bucket.blob(f"{prefix}/metadata.json")
            if not meta_blob.exists():
                return None
            meta = json.loads(meta_blob.download_as_text())
            if not skip_freshness_check and not is_model_fresh(
                {"trained_at": meta.get("trained_at", "")}, max_age_days=9
            ):
                logger.info(f"[Regime] GCS 模型 ({prefix}) 已過期，需重訓")
                return None
            model_blob = bucket.blob(f"{prefix}/hmm_detector.joblib")
            if not model_blob.exists():
                return None
            buf = io.BytesIO()
            model_blob.download_to_file(buf); buf.seek(0)
            det = joblib.load(buf)
            logger.info(f"[Regime] 已從 GCS ({prefix}) 載入 HMM detector")
            return det
        except Exception as e:
            logger.warning(f"[Regime] GCS load 失敗 ({gcs_prefix}): {e}")
            return None


# ── 特徵建構工具 ───────────────────────────────────────────────────────────────
def build_market_feature_matrix(market_env: dict | None) -> np.ndarray | None:
    """
    從 market_env.history 建立供 HMM 訓練的特徵矩陣
    Returns shape (n_days, 6) or None.
    Features: [ret_1d, ret_5d, risk_score, bias_20d, abs_ret_1d, realized_vol_3d]
    """
    if not market_env:
        return None
    history = market_env.get("history", {})
    if not history or len(history) < 20:
        return None

    # H5 fix: add short-term features for faster regime detection
    rows = []
    sorted_dates = sorted(history.keys())
    for i, date in enumerate(sorted_dates):
        row = history[date]
        ret_1d = float(row.get("market_return_1d", 0) or 0)
        rows.append([
            ret_1d,
            float(row.get("market_return_5d",  0) or 0),
            float(row.get("risk_score",       50) or 50) / 100,
            float(row.get("market_bias_20d",   0) or 0),
            abs(ret_1d),  # H5: intraday volatility proxy (|1d return|)
            # H5: 3-day realized volatility (std of last 3 returns)
            float(np.std([
                float(history.get(sorted_dates[max(0, i-j)], {}).get("market_return_1d", 0) or 0)
                for j in range(min(3, i+1))
            ])) if i >= 2 else abs(ret_1d),
        ])

    if len(rows) < 20:
        return None
    return np.array(rows, dtype=float)


def get_current_market_features(market_env: dict | None) -> np.ndarray | None:
    """從 market_env 取當前（最新一天）的 6 維特徵向量（與 build_market_feature_matrix 對齊）"""
    if not market_env:
        return None
    history = market_env.get("history", {})

    # 嘗試從 history 取最新一天
    if history:
        latest_date = max(history.keys())
        row = history[latest_date]
    else:
        row = market_env  # 直接用當前值

    ret_1d = float(row.get("market_return_1d", 0) or 0)
    # H5: include short-term features for faster regime detection
    return np.array([
        ret_1d,
        float(row.get("market_return_5d",  0) or 0),
        float(row.get("risk_score",       50) or 50) / 100,
        float(row.get("market_bias_20d",   0) or 0),
        abs(ret_1d),  # intraday volatility proxy
        abs(ret_1d),  # 3d vol placeholder (single-day, no history here)
    ], dtype=float)
