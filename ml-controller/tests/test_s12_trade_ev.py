from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.s12_trade_ev import build_s12_trade_ev_from_replay, extract_s12_trade_ev  # noqa: E402


def test_build_s12_trade_ev_from_replay_outputs_full_trade_ev_contract():
    samples = [
        {"exit_price": 108, "mfe_pct": 0.10, "mae_pct": -0.02, "bars_to_exit": 8, "exit_reason": "tp2"},
        {"exit_price": 104, "mfe_pct": 0.06, "mae_pct": -0.01, "bars_to_exit": 5, "exit_reason": "tp1"},
        {"exit_price": 96, "mfe_pct": 0.02, "mae_pct": -0.05, "bars_to_exit": 4, "exit_reason": "structure_stop"},
    ] * 10

    ev = build_s12_trade_ev_from_replay(
        symbol="8091",
        entry_price=100,
        stop_price=96,
        samples=samples,
        min_samples=30,
        roundtrip_cost_bps=20,
    )

    assert ev["status"] == "loaded"
    assert ev["semantic"] == "trade_expected_return_not_5bar_close_forecast"
    assert ev["sampleCount"] == 30
    assert ev["risk_pct"] == pytest.approx(0.04)
    assert ev["trade_expected_return_gross_pct"] == pytest.approx((0.08 + 0.04 - 0.04) / 3)
    assert ev["trade_expected_return_net_pct"] == pytest.approx(((0.08 + 0.04 - 0.04) / 3) - 0.002)
    assert ev["expected_R"] == pytest.approx(((2.0 + 1.0 - 1.0) / 3), abs=1e-6)
    assert ev["win_rate"] == pytest.approx(2 / 3)
    assert ev["payoff_ratio"] == pytest.approx(1.5)
    assert ev["profit_factor"] == pytest.approx(3.0)
    assert ev["exit_reason_distribution"] == {"structure_stop": 10, "tp1": 10, "tp2": 10}


def test_extract_s12_trade_ev_accepts_nested_forecast_payload():
    payload = {
        "s12_trade_ev": {
            "status": "loaded",
            "source": "s12_replay_trade_outcomes",
            "trade_expected_return_net_pct": 0.024,
        }
    }

    value, source, evidence = extract_s12_trade_ev({"forecast_data": json.dumps(payload)})

    assert value == pytest.approx(0.024)
    assert source == "s12_replay_trade_outcomes"
    assert evidence["status"] == "loaded"


def test_extract_s12_trade_ev_fails_closed_when_missing():
    value, source, evidence = extract_s12_trade_ev({"forecast_data": "{}"})

    assert value is None
    assert source == "s12_trade_ev_missing_no_allocation_edge"
    assert evidence is None


def test_build_s12_trade_ev_uses_direct_r_when_candidate_risk_available():
    samples = [
        {"trade_pnl_r": 1.5, "exit_reason": "structure_take_profit"},
        {"trade_pnl_r": -1.0, "exit_reason": "structure_stop"},
        {"trade_pnl_r": 0.5, "exit_reason": "time_exit"},
    ] * 10

    ev = build_s12_trade_ev_from_replay(
        symbol="8091",
        entry_price=100,
        stop_price=95,
        samples=samples,
        min_samples=30,
        roundtrip_cost_bps=0,
    )

    assert ev["status"] == "loaded"
    assert ev["trade_expected_return_gross_pct"] == pytest.approx(((1.5 - 1.0 + 0.5) / 3) * 0.05)
    assert ev["expected_R"] == pytest.approx((1.5 - 1.0 + 0.5) / 3)
