import numpy as np
import pytest

from app.target_rank_scope import (
    GLOBAL_CROSS_SECTIONAL_RANK_VERSION,
    recompute_global_cross_sectional_rank,
)


def test_global_rank_rebuilds_one_market_date_universe_across_batches():
    # Two prep batches containing one date must share one ranking universe.
    returns = np.asarray([0.01, 0.04, -0.02, 0.02], dtype=float)
    dates = np.asarray(["2026-08-21"] * 4, dtype=object)
    markets = np.asarray(["TW"] * 4, dtype=object)

    ranked = recompute_global_cross_sectional_rank(returns, dates, markets)

    assert GLOBAL_CROSS_SECTIONAL_RANK_VERSION == "global-market-date-cross-sectional-rank-v1"
    assert ranked.tolist() == pytest.approx([0.5, 1.0, 0.25, 0.75])
    assert int(np.argmax(ranked)) == 1


def test_global_rank_keeps_market_universes_separate():
    returns = np.asarray([0.01, 0.04, -0.02, 0.02], dtype=float)
    dates = np.asarray(["2026-08-21"] * 4, dtype=object)
    markets = np.asarray(["TW", "TW", "US", "US"], dtype=object)

    ranked = recompute_global_cross_sectional_rank(returns, dates, markets)

    assert ranked.tolist() == pytest.approx([0.5, 1.0, 0.5, 1.0])


def test_global_rank_fails_closed_without_complete_raw_targets():
    with pytest.raises(ValueError, match="aligned_raw_targets"):
        recompute_global_cross_sectional_rank(
            np.asarray([0.01], dtype=float),
            np.asarray([], dtype=object),
        )
