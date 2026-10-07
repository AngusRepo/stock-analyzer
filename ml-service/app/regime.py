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
import hashlib
from .hmm_input_contract import CONTRACT_HASH, FEATURES, validate_environment
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── 各 Regime 的模型權重調整方案 ──────────────────────────────────────────────
# 0 = 低波動牛市：趨勢動能強，純價格模型（Kalman, ARIMA）訊號可靠
# 1 = 高波動市場：保留現有模型權重政策，待逐日重播驗收
# 2 = 震盪整理：訊號雜訊高，整體降信心，收緊共識門檻
# 3 = 熊市危機：所有模型保守，GP 寬區間反而誠實
DEFAULT_REGIME_CONFIG = {
    0: {"label": "低波動牛市", "price_mult": 1.2,  "feature_mult": 1.0,  "consensus_threshold": 0.55},
    1: {"label": "高波動市場", "price_mult": 0.9,  "feature_mult": 1.25, "consensus_threshold": 0.60},
    2: {"label": "震盪整理",   "price_mult": 0.8,  "feature_mult": 0.85, "consensus_threshold": 0.68},
    3: {"label": "熊市危機",   "price_mult": 0.65, "feature_mult": 0.75, "consensus_threshold": 0.72},
}
REGIME_CONFIG = DEFAULT_REGIME_CONFIG  # runtime alias, overridden by regime_config_override
REGIME_SURFACE_LABELS = {
    0: "bull_market",
    1: "volatile",
    2: "sideways",
    3: "bear_market",
}

PRICE_MODEL_NAMES   = {"DLinear", "PatchTST", "iTransformer"}
FEATURE_MODEL_NAMES = {"LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"}
REGIME_FEATURE_WIDTH = 6
REGIME_SEMANTIC_MAPPING_VERSION = "emission_direction_vol_v2"


class RegimeDetector:
    def __init__(self):
        self.model          = None
        self.n_components   = 3
        self.regime_map     = {}   # HMM state index → semantic regime index (0-3)
        self.feature_means  = None
        self.feature_stds   = None
        self._trained       = False
        self.input_contract = None
        self.training_input_checksum = None
        self.artifact_identity = None

    # ── 訓練 ──────────────────────────────────────────────────────────────────
    def fit(self, features_raw: np.ndarray, *, input_contract: str | None = None, training_input_checksum: str | None = None) -> "RegimeDetector":
        """
        features_raw shape: (n_days, 6)
          col 0: market_return_1d
          col 1: market_return_5d
          col 2: risk_score (0-1)
          col 3: market_bias_20d
        """
        if input_contract != CONTRACT_HASH or not isinstance(training_input_checksum, str) or len(training_input_checksum) != 64:
            logger.warning("[Regime] verified input contract/checksum required; training skipped")
            return self
        features_raw = np.asarray(features_raw, dtype=float)
        if features_raw.ndim != 2 or features_raw.shape[1] != REGIME_FEATURE_WIDTH:
            logger.warning(
                "[Regime] invalid feature contract: shape=%s expected_width=%s",
                features_raw.shape,
                REGIME_FEATURE_WIDTH,
            )
            return self
        if not np.isfinite(features_raw).all():
            logger.warning("[Regime] non-finite feature values; training skipped")
            return self
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

        # Semantic labels describe the learned emissions, not relative state ranks.
        states = self.model.predict(features)
        self.regime_map = self._emission_semantic_regimes() or self._assign_semantic_regimes(features_raw, states)
        self._trained = True
        self.input_contract = input_contract
        self.training_input_checksum = training_input_checksum
        self.training_feature_checksum = hashlib.sha256(features_raw.astype("<f8").tobytes()).hexdigest()

        labels = [REGIME_CONFIG[self.regime_map.get(s, 1)]["label"] for s in range(best_n)]
        logger.info(f"[Regime] 訓練完成: {best_n} states, BIC={best_bic:.1f}, labels={labels}")
        return self

    def _assign_semantic_regimes(self, features_raw: np.ndarray, states: np.ndarray) -> dict:
        """Fallback for models without emission means; never force a class by rank."""
        baseline_vol = float(features_raw[:, 5].mean())
        regime_map: dict[int, int] = {}
        for state in range(self.n_components):
            mask = states == state
            if mask.sum() < 3:
                regime_map[state] = 2
                continue
            means = features_raw[mask].mean(axis=0)
            regime_map[state] = self._semantic_label(means, baseline_vol)
        return regime_map

    @staticmethod
    def _semantic_label(means: np.ndarray, baseline_vol: float) -> int:
        """Direction needs agreement across horizons; volatility uses its training baseline."""
        ret_1d, ret_5d, vol = float(means[0]), float(means[1]), float(means[5])
        if not np.isfinite([ret_1d, ret_5d, vol, baseline_vol]).all():
            return 2
        if ret_1d < 0 and ret_5d < 0:
            return 3
        if vol > baseline_vol:
            return 1
        if ret_1d > 0 and ret_5d > 0:
            return 0
        return 2

    def _emission_semantic_regimes(self) -> dict[int, int] | None:
        """Reinterpret an existing artifact in memory without fitting or rewriting it."""
        means = getattr(self.model, "means_", None)
        if means is None or self.feature_means is None or self.feature_stds is None:
            return None
        normalized_means = np.asarray(means, dtype=float)
        if normalized_means.ndim != 2 or normalized_means.shape[1] != REGIME_FEATURE_WIDTH:
            return None
        if len(self.feature_means) != REGIME_FEATURE_WIDTH or len(self.feature_stds) != REGIME_FEATURE_WIDTH:
            return None
        raw_means = normalized_means * self.feature_stds + self.feature_means
        baseline_vol = float(self.feature_means[5])
        return {state: self._semantic_label(row, baseline_vol) for state, row in enumerate(raw_means)}

    def predict_regime(self, current_features_raw: np.ndarray, regime_config_override: dict | None = None) -> dict:
        """Infer the latest regime from the full point-in-time feature sequence."""
        if regime_config_override:
            effective_config = {}
            for key, value in DEFAULT_REGIME_CONFIG.items():
                override_entry = regime_config_override.get(key) or regime_config_override.get(str(key)) or {}
                effective_config[key] = {
                    **value,
                    **{
                        override_key: float(override_value) if override_key != "label" else override_value
                        for override_key, override_value in override_entry.items()
                    },
                }
        else:
            effective_config = DEFAULT_REGIME_CONFIG

        default = {
            "regime_index": 2,
            "hmm_state": -1,
            "label": "sideways",
            "weight_multipliers": {},
            "consensus_threshold": 0.60,
            "regime_surface": {},
            "state_probabilities": {},
            "sequence_length": 0,
        }
        if not self._trained or self.model is None:
            return default

        try:
            sequence = np.asarray(current_features_raw, dtype=float)
            if sequence.ndim == 1:
                sequence = sequence.reshape(1, -1)
            if sequence.ndim != 2 or not len(sequence):
                return default
            if self.feature_means is None or self.feature_stds is None:
                return default
            if not np.isfinite(sequence).all() or not self.compatible():
                return default
            if sequence.shape[1] != len(self.feature_means):
                logger.warning(
                    "[Regime] feature width mismatch: got=%s expected=%s",
                    sequence.shape[1],
                    len(self.feature_means),
                )
                return default

            normalized = (sequence - self.feature_means) / self.feature_stds
            state_probabilities = np.asarray(self.model.predict_proba(normalized)[-1], dtype=float)
            if state_probabilities.ndim!=1 or not len(state_probabilities) or not np.isfinite(state_probabilities).all() or (state_probabilities<0).any() or state_probabilities.sum()<=0:
                return default
            state = int(np.argmax(state_probabilities))
            semantic_map = self._emission_semantic_regimes()
            effective_map = semantic_map if semantic_map is not None else self.regime_map
            regime_surface = {label: 0.0 for label in REGIME_SURFACE_LABELS.values()}
            for state_index, probability in enumerate(state_probabilities):
                regime_index = effective_map.get(state_index, 2)
                regime_surface[REGIME_SURFACE_LABELS[regime_index]] += float(probability)
            total_probability = sum(regime_surface.values())
            if total_probability <= 0:
                return default
            regime_surface = {
                label: probability / total_probability
                for label, probability in regime_surface.items()
            }
            regime_index = max(
                REGIME_SURFACE_LABELS,
                key=lambda index: regime_surface[REGIME_SURFACE_LABELS[index]],
            )
            config = effective_config.get(regime_index, effective_config[2])
            multipliers = {model: config["price_mult"] for model in PRICE_MODEL_NAMES}
            multipliers.update({model: config["feature_mult"] for model in FEATURE_MODEL_NAMES})
            regime_policies = {}
            for index, label in REGIME_SURFACE_LABELS.items():
                policy = effective_config[index]
                weights = {model: policy["price_mult"] for model in PRICE_MODEL_NAMES}
                weights.update({model: policy["feature_mult"] for model in FEATURE_MODEL_NAMES})
                regime_policies[label] = {
                    "label": policy["label"],
                    "weight_multipliers": weights,
                    "consensus_threshold": policy["consensus_threshold"],
                }

            return {
                "regime_index": regime_index,
                "hmm_state": state,
                "label": config["label"],
                "weight_multipliers": multipliers,
                "consensus_threshold": config["consensus_threshold"],
                "regime_policies": regime_policies,
                "regime_surface": regime_surface,
                "state_probabilities": {
                    str(index): float(probability)
                    for index, probability in enumerate(state_probabilities)
                },
                "state_semantic_map": {str(index): label for index, label in effective_map.items()},
                "sequence_length": int(len(sequence)),
                "semantic_mapping_version": REGIME_SEMANTIC_MAPPING_VERSION if semantic_map is not None else "legacy_artifact_map_v1",
            }
        except Exception as exc:
            logger.warning("[Regime] predict_regime failed: %s", exc)
            return default
    def compatible(self) -> bool:
        if getattr(self, "input_contract", None) != CONTRACT_HASH:
            return False
        means, stds = self.feature_means, self.feature_stds
        return bool(self._trained and self.model is not None and means is not None and stds is not None
                    and np.shape(means) == (6,) and np.shape(stds) == (6,)
                    and np.isfinite(means).all() and np.isfinite(stds).all() and (np.asarray(stds) > 0).all())

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
        if not self.compatible():
            return False
        try:
            import joblib
            bucket = _get_bucket()
            if not bucket:
                return False
            prefix = gcs_prefix.rstrip("/")
            buf = io.BytesIO()
            joblib.dump(self, buf); buf.seek(0)
            model_bytes = buf.getvalue()
            model_blob = bucket.blob(f"{prefix}/hmm_detector.joblib")
            model_blob.upload_from_file(buf)
            model_blob.reload()
            meta = {
                "n_components": self.n_components,
                "regime_map":   {str(k): v for k, v in self.regime_map.items()},
                "trained_at":   datetime.now(timezone.utc).isoformat(),
                "gcs_prefix":   prefix,
                "input_contract": CONTRACT_HASH,
                "feature_order": list(FEATURES),
                "training_input_checksum": self.training_input_checksum,
                "training_feature_checksum": self.training_feature_checksum,
                "training_parameters": {"random_state":42,"covariance_type":"full","max_components":5,"n_iter":300},
                "artifact_sha256": hashlib.sha256(model_bytes).hexdigest(),
                "artifact_generation": str(model_blob.generation),
            }
            if extra_metadata:
                meta.update({k: v for k, v in extra_metadata.items() if k not in meta})
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
            if meta.get("input_contract") != CONTRACT_HASH or meta.get("feature_order") != list(FEATURES):
                logger.error("[Regime] HMM_MODEL_INPUT_CONTRACT_INCOMPATIBLE")
                return None
            trained_at=datetime.fromisoformat(str(meta.get("trained_at","")).replace("Z","+00:00"))
            if trained_at.tzinfo is None or trained_at>datetime.now(timezone.utc):
                return None
            generation = meta.get("artifact_generation")
            if not str(generation or "").isdigit():
                return None
            model_blob = bucket.blob(f"{prefix}/hmm_detector.joblib", generation=int(generation))
            if not model_blob.exists():
                return None
            buf = io.BytesIO()
            model_blob.download_to_file(buf); buf.seek(0)
            if hashlib.sha256(buf.getvalue()).hexdigest() != meta.get("artifact_sha256"):
                logger.error("[Regime] HMM_MODEL_CHECKSUM_MISMATCH")
                return None
            det = joblib.load(buf)
            if not isinstance(det, cls) or not det.compatible() or getattr(det, "training_input_checksum", None) != meta.get("training_input_checksum"):
                return None
            det.artifact_identity = {"sha256": meta["artifact_sha256"], "generation": str(generation),
                                     "trained_at": meta.get("trained_at"), "input_contract": CONTRACT_HASH}
            logger.info(f"[Regime] 已從 GCS ({prefix}) 載入 HMM detector")
            return det
        except Exception as e:
            logger.warning(f"[Regime] GCS load 失敗 ({gcs_prefix}): {e}")
            return None


# ── 特徵建構工具 ───────────────────────────────────────────────────────────────
def build_market_feature_rows(market_env: dict | None) -> tuple[list[str], np.ndarray | None]:
    """Build one canonical PIT date vector and its HMM feature matrix."""
    try:
        history = validate_environment(market_env)
    except (ValueError, TypeError, KeyError):
        return [], None
    dates = sorted(history)
    rows = []
    for day in dates:
        row = history[day]
        ret = float(row["market_return_1d"])
        rows.append([ret, float(row["market_return_5d"]), float(row["risk_score"])/100,
                     float(row["market_bias_20d"]), abs(ret), float(row["realized_vol_3d"])])
    return dates, np.asarray(rows, dtype=float)


def build_market_feature_matrix(market_env: dict | None) -> np.ndarray | None:
    """Return the canonical PIT HMM feature matrix."""
    _, matrix = build_market_feature_rows(market_env)
    return matrix


def latest_market_feature_date(market_env: dict | None) -> str | None:
    dates, _ = build_market_feature_rows(market_env)
    return dates[-1] if dates else None


def get_current_market_features(market_env: dict | None) -> np.ndarray | None:
    """Return the latest row from the same feature builder used for training."""
    matrix = build_market_feature_matrix(market_env)
    return matrix[-1] if matrix is not None and len(matrix) else None
