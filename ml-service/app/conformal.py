"""
conformal.py — Split Conformal Prediction 校準器
取代 Isolation Forest hard gate，提供 calibrated prediction interval + uncertainty penalty。

架構位置：ensemble 之後、ARF 之前（第③層）
  ① HMM Regime → ② Models + LinUCB → ③ Conformal → ARF

運作原理：
  1. 收集歷史 nonconformity scores（|actual - predicted| / predicted）
  2. 給定 coverage level（如 90%），取 residuals 的 quantile 作為 interval width
  3. interval width 越寬 → uncertainty 越高 → confidence penalty 越大
  4. anomaly_score 作為額外 context，歷史上類似 anomaly 的預測準確率會影響校準

冷啟動：residuals 不足 MIN_CALIBRATION_SIZE 時，不套用校準（透明通過）
"""
import numpy as np
import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

MIN_CALIBRATION_SIZE = 20       # 最少需要多少歷史 residuals 才啟動校準（overridden at runtime via params）
MAX_RESIDUALS        = 500      # 最多保留多少筆 residuals（滑動窗口）
DEFAULT_COVERAGE     = 0.90     # 預設 coverage level（90% prediction interval, overridden at runtime via params）
STATE_DIR            = "/tmp/conformal_state"
GCS_STATE_KEY        = "meta/conformal_state.json"


class ConformalCalibrator:
    """Split Conformal Prediction — 校準 ensemble 預測的不確定性"""

    def __init__(self):
        self.residuals: list[float] = []            # |actual_return - forecast_pct|
        self.anomaly_residuals: list[tuple[float, float]] = []  # (anomaly_score, residual) pairs
        self._coverage = DEFAULT_COVERAGE

    # ── 校準（用歷史 residuals 計算 prediction interval）──────────────────────

    def calibrate(
        self,
        forecast_pct: float,
        confidence: float,
        anomaly_score: float = 0.0,
        coverage: float | None = None,
        params: dict | None = None,
    ) -> dict:
        """
        校準 ensemble 預測，回傳：
          - interval_width: prediction interval 寬度（±%）
          - uncertainty_penalty: 0~1 的 confidence 折扣
          - calibrated_confidence: 校準後的 confidence
          - coverage: 使用的 coverage level
          - is_calibrated: 是否有足夠 residuals 做校準

        params: optional KV adaptive dict — overrides MIN_CALIBRATION_SIZE / DEFAULT_COVERAGE
        """
        _params = params or {}
        _min_cal = int(_params.get("min_calibration_size", MIN_CALIBRATION_SIZE))
        _default_cov = float(_params.get("default_coverage", DEFAULT_COVERAGE))
        cov = coverage or _default_cov

        if len(self.residuals) < _min_cal:
            # 冷啟動：不校準，透明通過
            return {
                "interval_width": 0.0,
                "uncertainty_penalty": 1.0,
                "calibrated_confidence": confidence,
                "coverage": cov,
                "is_calibrated": False,
                "n_residuals": len(self.residuals),
            }

        # Split Conformal: quantile of historical residuals
        q = min(cov, (1.0 + cov) / 2.0)  # finite-sample correction
        residuals_arr = np.array(self.residuals[-MAX_RESIDUALS:])
        interval_width = float(np.quantile(residuals_arr, q))

        # ── Uncertainty penalty 計算 ──────────────────────────────────────────
        # interval_width 越大 → uncertainty 越高 → penalty 越重
        # 基準：median residual → penalty = 1.0（不折扣）
        median_residual = float(np.median(residuals_arr))
        if median_residual > 0:
            # ratio > 1 表示當前 interval 比中位數寬 → 不確定性偏高
            width_ratio = interval_width / median_residual
            # 映射：ratio=1 → penalty=1.0, ratio=2 → penalty=0.7, ratio=3+ → penalty=0.5
            uncertainty_penalty = max(0.5, min(1.0, 1.0 - (width_ratio - 1.0) * 0.15))
        else:
            uncertainty_penalty = 1.0

        # ── Anomaly context 額外修正 ──────────────────────────────────────────
        # 如果歷史上 anomaly_score 類似的預測殘差偏大，額外降低 confidence
        if anomaly_score < -0.5 and len(self.anomaly_residuals) >= 10:
            similar = [r for s, r in self.anomaly_residuals if abs(s - anomaly_score) < 0.15]
            if len(similar) >= 5:
                anomaly_avg_residual = np.mean(similar)
                if anomaly_avg_residual > median_residual * 1.5:
                    # 歷史上類似 anomaly 的預測殘差偏大 → 額外打折
                    uncertainty_penalty *= 0.85

        calibrated_confidence = confidence * uncertainty_penalty

        return {
            "interval_width": round(interval_width, 4),
            "uncertainty_penalty": round(uncertainty_penalty, 4),
            "calibrated_confidence": round(calibrated_confidence, 4),
            "coverage": cov,
            "is_calibrated": True,
            "n_residuals": len(self.residuals),
        }

    # ── 更新（每日用 actual 回填 residual）────────────────────────────────────

    def update(self, forecast_pct: float, actual_pct: float, anomaly_score: float = 0.0):
        """用實際值更新 residuals（由 verify cron 呼叫）"""
        residual = abs(actual_pct - forecast_pct)
        self.residuals.append(residual)

        # 維持滑動窗口
        if len(self.residuals) > MAX_RESIDUALS:
            self.residuals = self.residuals[-MAX_RESIDUALS:]

        # 記錄 anomaly context
        if anomaly_score != 0.0:
            self.anomaly_residuals.append((anomaly_score, residual))
            if len(self.anomaly_residuals) > MAX_RESIDUALS:
                self.anomaly_residuals = self.anomaly_residuals[-MAX_RESIDUALS:]

    # ── 持久化 ────────────────────────────────────────────────────────────────

    def save(self, path: str | None = None):
        """保存 residuals 到磁碟"""
        save_dir = Path(path or STATE_DIR)
        save_dir.mkdir(parents=True, exist_ok=True)
        state = self.to_state()
        (save_dir / "conformal_state.json").write_text(json.dumps(state))
        logger.info(f"[Conformal] saved {len(self.residuals)} residuals")

    def to_state(self) -> dict:
        return {
            "residuals": self.residuals[-MAX_RESIDUALS:],
            "anomaly_residuals": self.anomaly_residuals[-MAX_RESIDUALS:],
        }

    def load_state(self, state: dict) -> None:
        self.residuals = [float(x) for x in state.get("residuals", [])][-MAX_RESIDUALS:]
        self.anomaly_residuals = [
            (float(x[0]), float(x[1])) for x in state.get("anomaly_residuals", [])
        ][-MAX_RESIDUALS:]

    @classmethod
    def load(cls, path: str | None = None) -> "ConformalCalibrator":
        """從磁碟載入 residuals"""
        cal = cls()
        state_file = Path(path or STATE_DIR) / "conformal_state.json"
        if state_file.exists():
            try:
                state = json.loads(state_file.read_text())
                cal.load_state(state)
                logger.info(f"[Conformal] loaded {len(cal.residuals)} residuals")
            except Exception as e:
                logger.warning(f"[Conformal] load failed: {e}")
        return cal

    def is_calibrated(self, params: dict | None = None) -> bool:
        _min_cal = int((params or {}).get("min_calibration_size", MIN_CALIBRATION_SIZE))
        return len(self.residuals) >= _min_cal


# ── Convenience functions ─────────────────────────────────────────────────────

def _get_bucket():
    from .model_store import _get_bucket as _model_store_bucket
    return _model_store_bucket()


def _load_conformal_gcs() -> Optional[ConformalCalibrator]:
    try:
        bucket = _get_bucket()
        blob = bucket.blob(GCS_STATE_KEY)
        if not blob.exists():
            return None
        state = json.loads(blob.download_as_text())
        cal = ConformalCalibrator()
        cal.load_state(state)
        logger.info(f"[Conformal] loaded {len(cal.residuals)} residuals from GCS")
        return cal
    except Exception as e:
        logger.warning(f"[Conformal] GCS load failed: {e}")
        return None


def _save_conformal_gcs(calibrator: ConformalCalibrator) -> bool:
    try:
        bucket = _get_bucket()
        bucket.blob(GCS_STATE_KEY).upload_from_string(
            json.dumps(calibrator.to_state()),
            content_type="application/json",
        )
        logger.info(f"[Conformal] saved {len(calibrator.residuals)} residuals to GCS")
        return True
    except Exception as e:
        logger.warning(f"[Conformal] GCS save failed: {e}")
        return False


def load_conformal(path: str | None = None) -> ConformalCalibrator:
    """Load Conformal calibrator. GCS is authoritative; local storage is fallback."""
    return _load_conformal_gcs() or ConformalCalibrator.load(path)


def save_conformal(calibrator: ConformalCalibrator, path: str | None = None) -> dict:
    """Persist Conformal calibrator to GCS and local fallback."""
    gcs_saved = _save_conformal_gcs(calibrator)
    calibrator.save(path)
    return {
        "gcs_saved": gcs_saved,
        "local_saved": True,
        "n_residuals": len(calibrator.residuals),
    }


def apply_conformal_calibration(
    calibrator: ConformalCalibrator,
    forecast_pct: float,
    confidence: float,
    anomaly_score: float = 0.0,
    params: dict | None = None,
) -> tuple[float, dict]:
    """
    套用 Conformal 校準，回傳 (calibrated_confidence, calibration_info)。
    冷啟動時透明通過（calibrated_confidence == confidence）。
    params: optional KV adaptive dict forwarded to calibrate()。
    """
    info = calibrator.calibrate(forecast_pct, confidence, anomaly_score, params=params)
    return info["calibrated_confidence"], info
