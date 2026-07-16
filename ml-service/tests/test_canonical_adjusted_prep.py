import pytest

from app.canonical_adjusted_prep import build_adjusted_target_lookup
from app.sequence_training import CANONICAL_ROUNDTRIP_COST_BPS


def test_adjusted_target_lookup_uses_next_open_fifth_close_and_net_cost():
    dates = [f"2026-01-{day:02d}" for day in range(1, 8)]
    records = [{
        "symbol": "2330",
        "dates": dates,
        "open": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0],
        "close": [100.5, 101.5, 102.5, 103.5, 104.5, 111.0, 112.0],
    }]

    lookup = build_adjusted_target_lookup(records)

    expected = 111.0 / 101.0 - 1.0 - CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
    assert lookup["2330"]["2026-01-01"][0] == pytest.approx(expected)
    assert lookup["2330"]["2026-01-01"][1] == "2026-01-06"
