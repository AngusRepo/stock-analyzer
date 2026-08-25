from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.rfs_implementable_frontier_shadow import build_rfs_implementable_frontier_shadow


def test_rfs_linear_cost_proximal_step_rejects_micro_trade_below_cost() -> None:
    packet = build_rfs_implementable_frontier_shadow(
        [{
            "symbol": "AAA",
            "expected_return": 0.0005,
            "expected_return_owner": "l4_alpha_ev",
            "avg_daily_turnover_twd": 100_000_000.0,
        }],
        {"AAA": [0.0] * 40},
        incumbent_weights={},
        fee_bps=9.0,
        half_spread_bps=5.0,
        slippage_bps=3.0,
        impact_coefficient_bps=0.0,
    )

    assert packet["weights"] == {}
    assert packet["metrics"]["turnover_l1"] == 0.0
    assert packet["metrics"]["estimated_incremental_rebalance_cost"] == 0.0
