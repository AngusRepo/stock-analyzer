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


def test_lppls_weekly_bubble_monitor_requires_exact_score_input():
    returns = [0.002] * 25 + [0.006] * 10 + [0.012] * 10 + [0.020] * 10
    monitors = build_regime_monitors({"history": _history_from_returns(returns)})

    lppls = monitors["lppls_weekly_bubble"]

    assert lppls["decision_effect"] == "context_only"
    assert lppls["status"] == "missing_exact_input"
    assert lppls["score"] is None
    assert lppls["method"] == "exact_lppls_score_required"
    assert lppls["signals"]["required_input"] == "market_env.lppls_bubble_score"


def test_lppls_weekly_bubble_monitor_uses_provided_score():
    monitors = build_regime_monitors({"lppls_bubble_score": 0.82})
    lppls = monitors["lppls_weekly_bubble"]

    assert lppls["decision_effect"] == "context_only"
    assert lppls["status"] == "warning"
    assert lppls["score"] == 0.82
    assert lppls["method"] == "provided_lppls_score"


def test_hawkes_contagion_monitor_requires_exact_intensity_input():
    returns = [0.001] * 35 + [-0.026, -0.031, -0.018, -0.024, -0.029, -0.010, -0.022]
    history = _history_from_returns(returns)
    for key in list(history)[-7:]:
        history[key]["limit_down_pct"] = 0.009
        history[key]["us_vix"] = 34.0

    monitors = build_regime_monitors({"history": history, "us_vix": 35.0, "us_hy_spread_chg": 0.31})
    hawkes = monitors["hawkes_contagion"]

    assert hawkes["decision_effect"] == "context_only"
    assert hawkes["status"] == "missing_exact_input"
    assert hawkes["score"] is None
    assert hawkes["method"] == "exact_hawkes_intensity_required"
    assert hawkes["signals"]["required_input"] == "market_env.hawkes_contagion_intensity"


def test_hawkes_contagion_monitor_uses_provided_intensity():
    monitors = build_regime_monitors({"hawkes_contagion_intensity": 0.81})
    hawkes = monitors["hawkes_contagion"]

    assert hawkes["decision_effect"] == "context_only"
    assert hawkes["status"] == "warning"
    assert hawkes["score"] == 0.81
    assert hawkes["method"] == "provided_hawkes_score"


def test_monitors_without_exact_inputs_are_not_available_in_normal_market():
    returns = [0.001, -0.001, 0.002, 0.0, 0.001] * 12
    monitors = build_regime_monitors({"history": _history_from_returns(returns), "us_vix": 17.0})

    assert monitors["lppls_weekly_bubble"]["status"] == "missing_exact_input"
    assert monitors["lppls_weekly_bubble"]["score"] is None
    assert monitors["hawkes_contagion"]["status"] == "missing_exact_input"
    assert monitors["hawkes_contagion"]["score"] is None


def test_monitor_inputs_preserve_flat_zero_return_sessions():
    returns = [0.0] * 45
    monitors = build_regime_monitors({"history": _history_from_returns(returns), "us_vix": 16.0})

    assert monitors["lppls_weekly_bubble"]["signals"]["daily_rows"] == 45
    assert monitors["hawkes_contagion"]["signals"]["daily_rows"] == 45
