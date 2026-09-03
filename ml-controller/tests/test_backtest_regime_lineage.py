from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_engine import Trade, compute_metrics  # noqa: E402


def test_compute_metrics_materializes_entry_regime_for_downstream_monte_carlo():
    trade = Trade(
        symbol="2330",
        industry="半導體",
        entry_date="2026-08-25",
        exit_date="2026-08-26",
        entry_price=100.0,
        exit_price=101.0,
        shares=1000,
        profit_ratio=0.01,
        profit_amount=1000.0,
        exit_reason="test",
        days_held=1,
    )

    metrics = compute_metrics(
        trades=[trade],
        equity_curve=[("2026-08-25", 1_000_000.0), ("2026-08-26", 1_001_000.0)],
        entry_attempts=[],
        initial_capital=1_000_000.0,
        start_date="2026-08-25",
        end_date="2026-08-26",
        mode="B",
        regime_by_date={"2026-08-25": "yellow"},
    )

    assert trade.entry_regime == "yellow"
    assert metrics.trades[0].entry_regime == "yellow"
    assert metrics.per_regime["yellow"]["n_trades"] == 1
