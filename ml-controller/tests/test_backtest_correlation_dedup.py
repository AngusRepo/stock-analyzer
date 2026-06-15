from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_engine import (  # noqa: E402
    AccountState,
    Candidate,
    OpenPosition,
    PositionSizeParams,
    _correlation_dedup_skip,
)


class FakeDataset:
    def __init__(self, closes: dict[str, list[float]]):
        self.closes = closes

    def get_price_history_np(self, symbol: str, _end_date: str, lookback_days: int):
        values = self.closes.get(symbol, [])[-lookback_days:]
        if not values:
            return None
        return {
            "n": len(values),
            "close": np.asarray(values, dtype=float),
        }


def _require_similarity_deps() -> None:
    pytest.importorskip("networkx")
    pytest.importorskip("sklearn")


def _candidate(symbol: str) -> Candidate:
    return Candidate(
        symbol=symbol,
        date="2026-06-12",
        close=100,
        industry="Test",
        base_score=80,
        chip_score=20,
        tech_score=20,
        momentum_score=20,
        combined_score=80,
        has_buy_signal=1,
    )


def _account_with_position(symbol: str) -> AccountState:
    return AccountState(
        cash=1_000_000,
        initial_capital=1_000_000,
        positions={
            symbol: OpenPosition(
                symbol=symbol,
                industry="Held",
                entry_date="2026-06-01",
                entry_price=100,
                shares=1000,
                initial_stop=90,
                tp1_price=110,
                tp2_price=120,
                atr14=2,
                sl_mult=1.5,
                highest_since_entry=100,
            )
        },
    )


def test_backtest_correlation_dedup_skips_existing_cluster_concentration():
    _require_similarity_deps()
    dataset = FakeDataset({
        "AAA": [100, 101, 102, 103, 104, 105, 106],
        "BBB": [50, 50.5, 51, 51.5, 52, 52.5, 53],
    })

    skip = _correlation_dedup_skip(
        dataset,
        _candidate("BBB"),
        _account_with_position("AAA"),
        set(),
        "2026-06-12",
        PositionSizeParams(max_positions=5),
        {
            "enabled": True,
            "edgeThreshold": 0.1,
            "maxClusterPositions": 1,
        },
    )

    assert skip is not None
    assert skip[0] == "skipped_correlation_cluster"
    assert "existing=AAA" in skip[1]


def test_backtest_correlation_dedup_does_not_skip_when_graph_has_no_edge():
    _require_similarity_deps()
    dataset = FakeDataset({
        "AAA": [100, 101, 102, 103, 104, 105, 106],
        "CCC": [100, 98, 101, 97, 102, 96, 103],
    })

    skip = _correlation_dedup_skip(
        dataset,
        _candidate("CCC"),
        _account_with_position("AAA"),
        set(),
        "2026-06-12",
        PositionSizeParams(max_positions=5),
        {
            "enabled": True,
            "edgeThreshold": 0.95,
            "maxClusterPositions": 1,
        },
    )

    assert skip is None
