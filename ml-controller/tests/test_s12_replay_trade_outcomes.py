from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.s12_replay_trade_outcomes import (  # noqa: E402
    build_s12_trade_ev_from_replay_outcomes,
    s12_replay_outcome_to_bootstrap_row,
    s12_replay_outcome_to_ev_sample,
)


def _outcome(symbol: str = "8091", date: str = "2026-07-01", pnl: float = 0.04) -> dict:
    return {
        "schema_version": "s12-replay-trade-outcome-v1",
        "symbol": symbol,
        "trade_date": date,
        "status": "executed",
        "sample_eligible": True,
        "source": "s12_intraday_structure_replay_v1",
        "assessment_state": "reaction_ready",
        "setup_id": f"{symbol}:{date}",
        "entry_price": 100,
        "stop_price": 96,
        "pnl_pct": pnl,
        "trade_pnl_r": pnl / 0.04,
        "mfe_pct": max(pnl, 0.0),
        "mae_pct": min(pnl, 0.0),
        "bars_to_exit": 6,
        "exit_reason": "tp1" if pnl > 0 else "structure_stop",
    }


def test_s12_replay_outcome_to_ev_sample_requires_executed_outcome():
    assert s12_replay_outcome_to_ev_sample(_outcome())["return_pct"] == pytest.approx(0.04)
    setup = {**_outcome(), "status": "setup_only", "sample_eligible": False}
    assert s12_replay_outcome_to_ev_sample(setup) is None


def test_s12_replay_outcome_to_ev_sample_keeps_breakeven_trades():
    sample = s12_replay_outcome_to_ev_sample(_outcome(pnl=0.0))

    assert sample is not None
    assert sample["return_pct"] == pytest.approx(0.0)
    assert sample["trade_pnl_r"] == pytest.approx(0.0)


def test_build_s12_trade_ev_from_replay_outcomes_retires_cold_when_min_samples_met():
    outcomes = []
    for day in range(10):
        date = f"2026-07-{day + 1:02d}"
        outcomes.extend([
            _outcome(date=date, pnl=0.04),
            _outcome(date=date, pnl=0.08),
            _outcome(date=date, pnl=-0.04),
        ])

    ev = build_s12_trade_ev_from_replay_outcomes(
        symbol="8091",
        entry_price=100,
        stop_price=96,
        outcomes=outcomes,
        min_samples=30,
        roundtrip_cost_bps=0,
    )

    assert ev["status"] == "loaded"
    assert ev["source"] == "s12_replay_trade_outcomes"
    assert ev["sample_policy"] == "verified_s12_replay_executed_outcomes_only"
    assert ev["sampleCount"] == 30
    assert ev.get("cold_start") is None
    assert ev["trade_expected_return_source"] == "s12_replay_trade_outcomes"


def test_build_s12_trade_ev_from_replay_outcomes_blocks_when_samples_sparse():
    ev = build_s12_trade_ev_from_replay_outcomes(
        symbol="8091",
        entry_price=100,
        stop_price=96,
        outcomes=[_outcome()] * 4,
        min_samples=30,
    )

    assert ev["status"] == "insufficient_samples"
    assert ev["trade_expected_return_source"].endswith("_insufficient_samples")


def test_s12_replay_outcome_to_bootstrap_row_has_verified_s12_trade_ev_provenance():
    row = s12_replay_outcome_to_bootstrap_row(_outcome())

    assert row is not None
    assert row["symbol"] == "8091"
    assert row["prediction_date"] == "2026-07-01"
    assert row["trade_signal"] == "buy"
    assert row["trade_pnl_pct"] == pytest.approx(0.04)
    assert '"s12_trade_ev"' in row["forecast_data"]
    assert '"trade_expected_return_not_5bar_close_forecast"' in row["forecast_data"]
