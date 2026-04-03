"""Weighted vote ensemble tests — signal mapping and edge cases."""
import pytest
from dataclasses import dataclass, field


@dataclass
class MockPrediction:
    model_name: str
    direction: str
    confidence: float
    forecast_pct: float
    direction_accuracy: float = 0.6
    forecasts: list = field(default_factory=list)
    rmse: float = 0.0


def _import_weighted_vote():
    from app.ensemble import weighted_vote
    return weighted_vote


class TestWeightedVote:
    """Core ensemble voting logic."""

    def test_unanimous_up_strong_buy(self):
        """All models predict up with high confidence → STRONG_BUY or BUY."""
        wv = _import_weighted_vote()
        preds = [MockPrediction(f"m{i}", "up", 0.85, 0.03) for i in range(10)]
        result = wv(preds, current_price=100, atr=2.0)
        assert result.signal in ("STRONG_BUY", "BUY")
        assert result.direction == "up"
        assert result.confidence > 0.5

    def test_unanimous_down_sell(self):
        """All models predict down → STRONG_SELL or SELL."""
        wv = _import_weighted_vote()
        preds = [MockPrediction(f"m{i}", "down", 0.85, -0.03) for i in range(10)]
        result = wv(preds, current_price=100, atr=2.0)
        assert result.signal in ("STRONG_SELL", "SELL")
        assert result.direction == "down"

    def test_mixed_low_confidence_hold_or_nosignal(self):
        """Mixed directions + low confidence → HOLD or NO_SIGNAL."""
        wv = _import_weighted_vote()
        preds = [
            MockPrediction(f"up{i}", "up", 0.35, 0.005, 0.5) for i in range(5)
        ] + [
            MockPrediction(f"dn{i}", "down", 0.35, -0.005, 0.5) for i in range(5)
        ]
        result = wv(preds, current_price=100, atr=2.0)
        assert result.signal in ("HOLD", "NO_SIGNAL")

    def test_empty_predictions_no_signal(self):
        """No predictions → NO_SIGNAL."""
        wv = _import_weighted_vote()
        result = wv([], current_price=100, atr=2.0)
        assert result.signal == "NO_SIGNAL"

    def test_stop_loss_target_present(self):
        """Result should contain stop_loss < entry < target1."""
        wv = _import_weighted_vote()
        preds = [MockPrediction(f"m{i}", "up", 0.7, 0.02) for i in range(5)]
        result = wv(preds, current_price=100, atr=2.0)
        assert result.stop_loss < 100
        assert result.target1 > 100
        assert result.stop_loss < result.target1

    def test_high_accuracy_increases_influence(self):
        """Models with higher real accuracy should win the vote."""
        wv = _import_weighted_vote()
        preds = [
            MockPrediction("good1", "up", 0.7, 0.02, 0.8),
            MockPrediction("good2", "up", 0.7, 0.02, 0.8),
            MockPrediction("good3", "up", 0.7, 0.02, 0.8),
            MockPrediction("bad1", "down", 0.7, -0.02, 0.3),
            MockPrediction("bad2", "down", 0.7, -0.02, 0.3),
        ]
        result = wv(preds, current_price=100, atr=2.0,
                     real_accuracies={"good1": 0.8, "good2": 0.8, "good3": 0.8, "bad1": 0.3, "bad2": 0.3})
        assert result.direction == "up"

    def test_garch_vol_affects_stoploss(self):
        """Higher GARCH vol → wider stop loss."""
        wv = _import_weighted_vote()
        preds = [MockPrediction(f"m{i}", "up", 0.7, 0.02) for i in range(5)]
        r_low = wv(preds, current_price=100, atr=1.0, garch_vol=1.0)
        r_high = wv(preds, current_price=100, atr=1.0, garch_vol=5.0)
        assert r_high.stop_loss <= r_low.stop_loss

    def test_confidence_range(self):
        """Confidence should be 0-1."""
        wv = _import_weighted_vote()
        preds = [MockPrediction(f"m{i}", "up", 0.6, 0.01) for i in range(7)]
        result = wv(preds, current_price=100, atr=2.0)
        assert 0 <= result.confidence <= 1

    def test_signal_strength_range(self):
        """signal_strength should be 1-5."""
        wv = _import_weighted_vote()
        preds = [MockPrediction(f"m{i}", "up", 0.75, 0.02) for i in range(8)]
        result = wv(preds, current_price=100, atr=2.0)
        assert 1 <= result.signal_strength <= 5
