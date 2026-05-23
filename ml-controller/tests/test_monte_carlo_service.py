from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.monte_carlo_service import (
    BACKTEST_REGIME_CLOSED_LOOP_MISSING,
    _build_tail_risk_diagnostics,
    _extract_backtest_returns_and_regimes,
    _filter_backtest_trades_for_exclusion,
    _resolve_source_and_exclusion,
    _resolve_simulation_method,
    _run_monte_carlo,
)


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


def test_auto_method_uses_regime_bootstrap_for_backtest_closed_loop():
    assert _resolve_simulation_method("backtest", None, ["green", "red"]) == "regime_block_bootstrap"


def test_auto_method_fails_when_backtest_regime_closed_loop_missing():
    try:
        _resolve_simulation_method("backtest", None, None)
    except ValueError as exc:
        assert str(exc) == BACKTEST_REGIME_CLOSED_LOOP_MISSING
    else:
        raise AssertionError("Expected backtest MC to fail closed without regimes")


def test_explicit_legacy_block_bootstrap_remains_manual_comparison_only():
    assert _resolve_simulation_method("backtest", "block_bootstrap", None) == "block_bootstrap"


def test_auto_method_keeps_paper_on_block_bootstrap():
    assert _resolve_simulation_method("paper", None, None) == "block_bootstrap"


def test_curated_source_defaults_to_early_strategy_exclusions():
    base, effective, symbols, metadata = _resolve_source_and_exclusion("backtest_curated", None)

    assert base == "backtest"
    assert effective == "backtest_curated"
    assert symbols == ["8047", "2640"]
    assert metadata["enabled"] is True
    assert metadata["default_symbols_applied"] is True


def test_backtest_curated_exclusion_filters_trades_and_regimes():
    raw = {
        "trades": [
            {"symbol": "8047", "profit_ratio": -0.18, "entry_regime": "red"},
            {"symbol": "2640", "profit_ratio": -0.12, "entry_regime": "red"},
            {"symbol": "2330", "profit_ratio": 0.04, "entry_regime": "green"},
            {"symbol": "2454", "profit_ratio": -0.02, "entry_regime": "green"},
            {"symbol": "2317", "profit_ratio": 0.03, "entry_regime": "sideways"},
        ],
    }

    returns, regimes, trades, metadata = _filter_backtest_trades_for_exclusion(raw, ["8047", "2640"])

    assert returns == [0.04, -0.02, 0.03]
    assert regimes == ["green", "green", "sideways"]
    assert [trade["symbol"] for trade in trades] == ["2330", "2454", "2317"]
    assert metadata["original_trade_count"] == 5
    assert metadata["excluded_trade_count"] == 2
    assert metadata["remaining_trade_count"] == 3


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


def test_extract_backtest_returns_and_regimes_drops_all_unknown_regimes():
    raw = {
        "all_returns": [0.01, -0.02, 0.03],
        "all_regimes": ["unknown", "unknown", "unknown"],
    }

    returns, regimes = _extract_backtest_returns_and_regimes(raw)

    assert returns == [0.01, -0.02, 0.03]
    assert regimes is None


def test_tail_risk_diagnostics_exposes_loss_cluster_and_regime_gap():
    diagnostics = _build_tail_risk_diagnostics(
        [0.12, -0.13, -0.18, 0.04, -0.11],
        trades=[
            {"symbol": "2330", "entry_date": "2026-03-25", "exit_date": "2026-03-31", "profit_ratio": -0.13, "exit_reason": "HardStop (-13.0%)"},
            {"symbol": "2454", "entry_date": "2026-03-26", "exit_date": "2026-04-01", "profit_ratio": -0.18, "exit_reason": "HardStop (-18.0%)"},
        ],
        trade_regimes=None,
        backtest_summary={"max_drawdown": 0.42, "sharpe": 1.2},
    )

    assert diagnostics["loss_gt_10pct_count"] == 3
    assert diagnostics["hard_stop_loss_count"] == 2
    assert diagnostics["regime_closed_loop"] is False
    assert diagnostics["backtest_max_drawdown"] == 0.42
