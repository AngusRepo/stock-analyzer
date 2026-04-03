"""Conformal Prediction calibration tests."""
import pytest
import numpy as np


def _import_calibrator():
    from app.conformal import ConformalCalibrator
    return ConformalCalibrator


class TestConformalCalibrator:
    """Split conformal prediction calibration."""

    def test_cold_start_passthrough(self):
        """Before min samples, confidence should pass through unchanged."""
        Cal = _import_calibrator()
        cal = Cal()
        for i in range(5):
            cal.update(0.02, 0.01)
        result = cal.calibrate(forecast_pct=0.02, confidence=0.75, anomaly_score=0.0)
        assert result["calibrated_confidence"] == pytest.approx(0.75, abs=0.01)
        assert result["is_calibrated"] is False

    def test_calibrated_reduces_confidence(self):
        """After enough samples with large residuals, confidence should decrease."""
        Cal = _import_calibrator()
        cal = Cal()
        for _ in range(30):
            cal.update(0.05, -0.03)  # |0.08| large residual
        result = cal.calibrate(forecast_pct=0.05, confidence=0.80, anomaly_score=0.0)
        assert result["is_calibrated"] is True
        assert result["calibrated_confidence"] <= 0.80
        assert result["uncertainty_penalty"] <= 1.0

    def test_perfect_predictions_preserve_confidence(self):
        """If predictions are accurate, confidence stays close to input."""
        Cal = _import_calibrator()
        cal = Cal()
        for _ in range(30):
            cal.update(0.02, 0.02)  # perfect
        result = cal.calibrate(forecast_pct=0.02, confidence=0.80, anomaly_score=0.0)
        assert result["is_calibrated"] is True
        assert result["calibrated_confidence"] >= 0.70

    def test_interval_width_positive(self):
        """Interval width should always be non-negative."""
        Cal = _import_calibrator()
        cal = Cal()
        for _ in range(25):
            cal.update(0.01, 0.005)
        result = cal.calibrate(forecast_pct=0.01, confidence=0.60, anomaly_score=0.0)
        assert result["interval_width"] >= 0

    def test_anomaly_context_penalty(self):
        """High anomaly score → extra penalty."""
        Cal = _import_calibrator()
        cal = Cal()
        for _ in range(25):
            cal.update(0.05, -0.03, anomaly_score=-0.8)
        r_normal = cal.calibrate(forecast_pct=0.05, confidence=0.80, anomaly_score=0.0)
        r_anomaly = cal.calibrate(forecast_pct=0.05, confidence=0.80, anomaly_score=-0.8)
        assert r_anomaly["calibrated_confidence"] <= r_normal["calibrated_confidence"]
