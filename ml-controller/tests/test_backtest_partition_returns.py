from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_engine import Trade, compute_trade_partition_returns  # noqa: E402


def _trade(exit_date: str, profit_ratio: float) -> Trade:
    return Trade(
        symbol="2330",
        industry="semiconductor",
        entry_date="2026-01-01",
        exit_date=exit_date,
        entry_price=100.0,
        exit_price=110.0,
        shares=1000,
        profit_ratio=profit_ratio,
        profit_amount=profit_ratio * 100_000,
        exit_reason="test",
        days_held=3,
    )


def test_compute_trade_partition_returns_sorts_by_exit_date_and_compounds():
    trades = [
        _trade("2026-01-04", 0.04),
        _trade("2026-01-01", 0.10),
        _trade("2026-01-03", -0.02),
        _trade("2026-01-02", -0.05),
        _trade("2026-01-06", 0.03),
        _trade("2026-01-05", 0.02),
    ]

    out = compute_trade_partition_returns(trades, n_partitions=3)

    assert out == [
        round((1.10 * 0.95) - 1.0, 10),
        round((0.98 * 1.04) - 1.0, 10),
        round((1.02 * 1.03) - 1.0, 10),
    ]


def test_compute_trade_partition_returns_keeps_equal_length_for_sparse_trades():
    out = compute_trade_partition_returns([_trade("2026-01-01", 0.05)], n_partitions=4)

    assert out == [0.05, 0.0, 0.0, 0.0]
