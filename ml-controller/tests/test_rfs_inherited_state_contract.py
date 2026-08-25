from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.rfs_implementable_frontier_shadow import build_rfs_implementable_frontier_shadow


def test_rfs_compares_sparse_and_challenger_from_same_inherited_portfolio() -> None:
    candidates = [
        {
            "symbol": "AAA",
            "expected_return": 0.03,
            "expected_return_owner": "l4_alpha_ev",
            "avg_daily_turnover_twd": 100_000_000.0,
        },
        {
            "symbol": "BBB",
            "expected_return": 0.01,
            "expected_return_owner": "l4_alpha_ev",
            "avg_daily_turnover_twd": 100_000_000.0,
        },
    ]
    packet = build_rfs_implementable_frontier_shadow(
        candidates,
        {"AAA": [0.001] * 40, "BBB": [-0.001] * 40},
        incumbent_weights={"AAA": 0.5},
        inherited_weights={"BBB": 0.5},
        max_weight=0.5,
    )

    assert "inherited_portfolio_weights_missing" not in packet["validation_blockers"]
    assert packet["cost_reference"] == "inherited_portfolio_weights"
    assert packet["incumbent_weights"] == {"AAA": 0.5}
    assert packet["metrics"]["incumbent_rebalance_cost"] > 0


def test_rfs_missing_inherited_portfolio_is_never_promotion_ready() -> None:
    packet = build_rfs_implementable_frontier_shadow(
        [{
            "symbol": "AAA",
            "expected_return": 0.03,
            "expected_return_owner": "l4_alpha_ev",
            "avg_daily_turnover_twd": 100_000_000.0,
        }],
        {"AAA": [0.001] * 40},
        incumbent_weights={"AAA": 0.25},
    )

    assert packet["status"] == "shadow_observation_only"
    assert "inherited_portfolio_weights_missing" in packet["validation_blockers"]
    assert packet["promotion_eligible"] is False
