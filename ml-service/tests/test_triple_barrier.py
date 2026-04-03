"""Triple Barrier labeling tests — known price sequences."""
import numpy as np
import pandas as pd
import pytest
from app.features import compute_triple_barrier_labels


def _make_series(values):
    return pd.Series(values, dtype=float)


class TestTripleBarrier:
    """Core triple barrier label logic."""

    def test_clear_upper_hit(self):
        """Price rallies → should label 1.0 (profit)."""
        close = _make_series([100, 102, 105, 110, 115, 120])
        high = _make_series([101, 103, 106, 112, 118, 125])
        low = _make_series([99, 101, 104, 109, 114, 119])
        atr = _make_series([2.0] * 6)  # upper barrier = 100 + min(6, 7) = 106
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert labels.iloc[0] == 1.0

    def test_clear_lower_hit(self):
        """Price drops → should label 0.0 (loss)."""
        close = _make_series([100, 98, 95, 92, 90, 88])
        high = _make_series([101, 99, 96, 93, 91, 89])
        low = _make_series([99, 96, 93, 90, 88, 86])
        atr = _make_series([2.0] * 6)  # lower barrier = 100 - min(4, 3) = 97
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert labels.iloc[0] == 0.0

    def test_no_barrier_hit_returns_nan(self):
        """Flat price within barriers → should be NaN (expired)."""
        close = _make_series([100.0] * 5)
        high = _make_series([100.5] * 5)
        low = _make_series([99.5] * 5)
        atr = _make_series([5.0] * 5)  # wide barriers: upper=115, lower=90
        labels = compute_triple_barrier_labels(close, high, low, atr, max_days=3)
        assert np.isnan(labels.iloc[0])

    def test_same_day_both_hit_uses_close(self):
        """Both barriers hit same day → use close to decide."""
        close = _make_series([100, 105])  # close above entry → label=1
        high = _make_series([100, 120])   # hits upper
        low = _make_series([100, 80])     # also hits lower
        atr = _make_series([3.0, 3.0])    # upper=109, lower=94
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert labels.iloc[0] == 1.0  # close=105 >= entry=100

    def test_pct_cap_limits_barrier(self):
        """ATR-based barrier should be capped by percentage."""
        close = _make_series([100, 100, 100, 100, 100, 108])
        high = _make_series([100, 100, 100, 100, 100, 108])
        low = _make_series([100, 100, 100, 100, 100, 108])
        atr = _make_series([50.0] * 6)  # ATR×3 = 150 but cap = 7% → upper = 107
        labels = compute_triple_barrier_labels(close, high, low, atr)
        # 108 > 107 (capped barrier) → should hit upper
        assert labels.iloc[0] == 1.0

    def test_nan_price_skipped(self):
        """NaN in close should be skipped."""
        close = _make_series([np.nan, 100, 105])
        high = _make_series([np.nan, 101, 108])
        low = _make_series([np.nan, 99, 104])
        atr = _make_series([2.0] * 3)
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert np.isnan(labels.iloc[0])

    def test_last_row_is_nan(self):
        """Last row has no future data → must be NaN."""
        close = _make_series([100, 105])
        high = _make_series([101, 106])
        low = _make_series([99, 104])
        atr = _make_series([2.0, 2.0])
        labels = compute_triple_barrier_labels(close, high, low, atr)
        assert np.isnan(labels.iloc[-1])
