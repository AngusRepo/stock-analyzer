from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.regime_monitors import build_regime_monitors  # noqa: E402


def _history_from_returns(returns: list[float], start_day: int = 1) -> dict[str, dict]:
    return {
        f"2026-03-{start_day + idx:02d}": {
            "market_return_1d": value,
            "limit_down_pct": 0.0,
        }
        for idx, value in enumerate(returns)
    }


def test_lppls_weekly_bubble_monitor_warns_on_accelerating_uptrend():
    returns = [0.002] * 25 + [0.006] * 10 + [0.012] * 10 + [0.020] * 10
    monitors = build_regime_monitors({"history": _history_from_returns(returns)})

    lppls = monitors["lppls_weekly_bubble"]

    assert lppls["decision_effect"] == "context_only"
    assert lppls["status"] == "warning"
    assert lppls["score"] >= 0.70
    assert lppls["method"] == "lppls_weekly_proxy_v1"
    assert lppls["signals"]["momentum_8w"] > 0
    assert lppls["signals"]["acceleration_4w"] > 0


def test_hawkes_contagion_monitor_warns_on_clustered_negative_shocks():
    returns = [0.001] * 35 + [-0.026, -0.031, -0.018, -0.024, -0.029, -0.010, -0.022]
    history = _history_from_returns(returns)
    for key in list(history)[-7:]:
        history[key]["limit_down_pct"] = 0.009
        history[key]["us_vix"] = 34.0

    monitors = build_regime_monitors({"history": history, "us_vix": 35.0, "us_hy_spread_chg": 0.31})
    hawkes = monitors["hawkes_contagion"]

    assert hawkes["decision_effect"] == "context_only"
    assert hawkes["status"] == "warning"
    assert hawkes["score"] >= 0.70
    assert hawkes["method"] == "hawkes_exponential_decay_proxy_v1"
    assert hawkes["signals"]["shock_count_10d"] >= 5


def test_monitors_are_available_but_not_warning_in_normal_market():
    returns = [0.001, -0.001, 0.002, 0.0, 0.001] * 12
    monitors = build_regime_monitors({"history": _history_from_returns(returns), "us_vix": 17.0})

    assert monitors["lppls_weekly_bubble"]["status"] == "available"
    assert monitors["lppls_weekly_bubble"]["score"] < 0.70
    assert monitors["hawkes_contagion"]["status"] == "available"
    assert monitors["hawkes_contagion"]["score"] < 0.70


def test_monitor_inputs_preserve_flat_zero_return_sessions():
    returns = [0.0] * 45
    monitors = build_regime_monitors({"history": _history_from_returns(returns), "us_vix": 16.0})

    assert monitors["lppls_weekly_bubble"]["signals"]["daily_rows"] == 45
    assert monitors["hawkes_contagion"]["signals"]["daily_rows"] == 45
