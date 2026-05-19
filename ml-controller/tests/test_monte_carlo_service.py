from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.monte_carlo_service import _extract_backtest_returns_and_regimes, _run_monte_carlo


def test_block_bootstrap_records_method_and_block_size():
    returns = [0.03, -0.02, -0.01, 0.04, -0.03, 0.02, 0.01, -0.04]

    result = _run_monte_carlo(
        returns,
        n_simulations=20,
        seed=7,
        method="block_bootstrap",
        block_size=3,
    )

    assert result.simulation_method == "block_bootstrap"
    assert result.block_size == 3
    assert len(result.mdds_sorted) == 20
    assert result.n_trades == len(returns)


def test_block_bootstrap_is_deterministic_for_same_seed():
    returns = [0.03, -0.02, -0.01, 0.04, -0.03, 0.02, 0.01, -0.04]

    first = _run_monte_carlo(
        returns,
        n_simulations=30,
        seed=11,
        method="block_bootstrap",
        block_size=2,
    )
    second = _run_monte_carlo(
        returns,
        n_simulations=30,
        seed=11,
        method="block_bootstrap",
        block_size=2,
    )

    assert first.mdds_sorted == second.mdds_sorted
    assert first.mdd_95th == second.mdd_95th


def test_iid_shuffle_remains_available_for_legacy_comparison():
    returns = [0.03, -0.02, -0.01, 0.04, -0.03, 0.02, 0.01, -0.04]

    result = _run_monte_carlo(
        returns,
        n_simulations=10,
        seed=3,
        method="iid_shuffle",
    )

    assert result.simulation_method == "iid_shuffle"
    assert result.block_size is None
    assert len(result.mdds_sorted) == 10


def test_low_sample_tail_risk_is_marked_as_caution_not_strategy_failure():
    returns = [0.03, -0.02, -0.01, 0.04, -0.03, 0.02, 0.01, -0.04, 0.02, -0.03, 0.01, -0.02, 0.03]

    result = _run_monte_carlo(
        returns,
        n_simulations=20,
        seed=13,
        method="block_bootstrap",
        block_size=3,
    )

    assert result.tail_risk_status == "LOW_SAMPLE_TAIL_RISK"
    assert result.min_full_tail_risk_trades == 30
    assert "LOW_SAMPLE_TAIL_RISK" in result.verdict_reason
    assert result.go_live_verdict in {"PASS", "CAUTION"}


def test_regime_block_bootstrap_records_regime_counts():
    returns = [0.03, -0.02, -0.01, 0.04, -0.03, 0.02, 0.01, -0.04]
    regimes = ["green", "green", "yellow", "yellow", "red", "red", "green", "green"]

    result = _run_monte_carlo(
        returns,
        n_simulations=20,
        seed=5,
        method="regime_block_bootstrap",
        block_size=2,
        trade_regimes=regimes,
    )

    assert result.simulation_method == "regime_block_bootstrap"
    assert result.regime_counts == {"green": 4, "yellow": 2, "red": 2}
    assert len(result.mdds_sorted) == 20


def test_regime_block_bootstrap_requires_matching_regime_series():
    returns = [0.03, -0.02, -0.01, 0.04, -0.03]

    try:
        _run_monte_carlo(
            returns,
            n_simulations=20,
            method="regime_block_bootstrap",
            trade_regimes=["green"],
        )
    except ValueError as exc:
        assert "trade_regimes" in str(exc)
    else:
        raise AssertionError("Expected ValueError for mismatched trade_regimes")


def test_extract_backtest_returns_and_regimes_prefers_full_arrays():
    raw = {
        "all_returns": [0.01, -0.02, 0.03],
        "all_regimes": ["green", "red", "green"],
        "trades": [{"profit_ratio": 0.99, "entry_regime": "ignored"}],
    }

    returns, regimes = _extract_backtest_returns_and_regimes(raw)

    assert returns == [0.01, -0.02, 0.03]
    assert regimes == ["green", "red", "green"]


def test_extract_backtest_returns_and_regimes_uses_trade_regimes_when_complete():
    raw = {
        "trades": [
            {"profit_ratio": 0.01, "entry_regime": "green"},
            {"profit_ratio": -0.02, "entry_regime": "red"},
        ],
    }

    returns, regimes = _extract_backtest_returns_and_regimes(raw)

    assert returns == [0.01, -0.02]
    assert regimes == ["green", "red"]


def test_extract_backtest_returns_and_regimes_drops_incomplete_regime_series():
    raw = {
        "all_returns": [0.01, -0.02, 0.03],
        "all_regimes": ["green"],
    }

    returns, regimes = _extract_backtest_returns_and_regimes(raw)

    assert returns == [0.01, -0.02, 0.03]
    assert regimes is None
