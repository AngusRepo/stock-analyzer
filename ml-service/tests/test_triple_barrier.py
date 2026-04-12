"""Triple Barrier labeling tests — known price sequences."""
import numpy as np
import pytest
from app.features import compute_triple_barrier_labels


def _arr(values):
    return np.array(values, dtype=np.float64)


class TestTripleBarrier:
    """Core triple barrier label logic."""

    def test_clear_upper_hit(self):
        """Price rallies → should label 1.0 (profit)."""
        close = _arr([100, 102, 105, 110, 115, 120])
        high = _arr([101, 103, 106, 112, 118, 125])
        low = _arr([99, 101, 104, 109, 114, 119])
        atr = _arr([2.0] * 6)
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert labels[0] == 1.0

    def test_clear_lower_hit(self):
        """Price drops → should label 0.0 (loss)."""
        close = _arr([100, 98, 95, 92, 90, 88])
        high = _arr([101, 99, 96, 93, 91, 89])
        low = _arr([99, 96, 93, 90, 88, 86])
        atr = _arr([2.0] * 6)
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert labels[0] == 0.0

    def test_no_barrier_hit_returns_nan(self):
        """Flat price within barriers → should be NaN (expired)."""
        close = _arr([100.0] * 5)
        high = _arr([100.5] * 5)
        low = _arr([99.5] * 5)
        atr = _arr([5.0] * 5)
        labels = compute_triple_barrier_labels(close, high, low, atr, max_days=3)
        assert np.isnan(labels[0])

    def test_same_day_both_hit_uses_close(self):
        """Both barriers hit same day → use close to decide."""
        close = _arr([100, 105])
        high = _arr([100, 120])
        low = _arr([100, 80])
        atr = _arr([3.0, 3.0])
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert labels[0] == 1.0

    def test_pct_cap_limits_barrier(self):
        """ATR-based barrier should be capped by percentage."""
        close = _arr([100, 100, 100, 100, 100, 108])
        high = _arr([100, 100, 100, 100, 100, 108])
        low = _arr([100, 100, 100, 100, 100, 108])
        atr = _arr([50.0] * 6)
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert labels[0] == 1.0

    def test_nan_price_skipped(self):
        """NaN in close should be skipped."""
        close = _arr([np.nan, 100, 105])
        high = _arr([np.nan, 101, 108])
        low = _arr([np.nan, 99, 104])
        atr = _arr([2.0] * 3)
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert np.isnan(labels[0])

    def test_last_row_is_nan(self):
        """Last row has no future data → must be NaN."""
        close = _arr([100, 105])
        high = _arr([101, 106])
        low = _arr([99, 104])
        atr = _arr([2.0, 2.0])
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert np.isnan(labels[-1])
