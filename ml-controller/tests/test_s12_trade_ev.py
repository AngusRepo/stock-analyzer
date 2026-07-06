from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.s12_trade_ev import (  # noqa: E402
    build_s12_trade_ev_from_replay,
    build_s12_trade_ev_from_structure,
    extract_s12_trade_ev,
)


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


def test_extract_s12_trade_ev_accepts_setup_only_allocator_edge():
    payload = {
        "s12_trade_ev": {
            "status": "setup_only",
            "trade_expected_return_net_pct": 0.012,
            "trade_expected_return_source": "s12_structural_setup_cold_start_ev",
            "execution_ready": False,
            "execution_gate_required": "s12_reaction_ready",
        }
    }

    value, source, evidence = extract_s12_trade_ev({"forecast_data": json.dumps(payload)})

    assert value == pytest.approx(0.012)
    assert source == "s12_structural_setup_cold_start_ev"
    assert evidence["status"] == "setup_only"
    assert evidence["execution_ready"] is False
    assert evidence["execution_gate_required"] == "s12_reaction_ready"


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


def test_build_s12_trade_ev_from_structure_outputs_conservative_cold_start_contract():
    ev = build_s12_trade_ev_from_structure(
        symbol="8091",
        entry_price=100,
        stop_price=96,
        target1_price=106,
        target2_price=112,
        avg_rank=0.72,
        ml_edge_score=18,
        technical_score=17,
        chip_score=28,
        fundamental_score=15,
        market_heat_expected_return=0.004,
        regime="bull",
        roundtrip_cost_bps=20,
    )

    assert ev["status"] == "loaded"
    assert ev["source"] == "s12_structural_cold_start_ev"
    assert ev["sample_policy"] == "s12_structural_cold_start_no_replay"
    assert ev["semantic"] == "trade_expected_return_not_5bar_close_forecast"
    assert ev["risk_pct"] == pytest.approx(0.04)
    assert ev["target1_price"] == 106
    assert ev["target2_price"] == 112
    assert 0 < ev["trade_expected_return_net_pct"] <= ev["cold_start_policy"]["positive_ev_cap"]
    assert 0.43 <= ev["win_rate"] <= 0.58
    assert ev["cold_start"] is True


def test_build_s12_trade_ev_from_structure_uses_score_v2_as_conservative_cold_start_tilt():
    weak = build_s12_trade_ev_from_structure(
        symbol="6257",
        entry_price=254.5,
        stop_price=224.14,
        target1_price=278.4085,
        target2_price=294.3475,
        avg_rank=0.5,
        ml_edge_score=12,
        technical_score=14,
        chip_score=20,
        fundamental_score=8,
        score_v2_final_score=50,
    )
    strong = build_s12_trade_ev_from_structure(
        symbol="6257",
        entry_price=254.5,
        stop_price=224.14,
        target1_price=278.4085,
        target2_price=294.3475,
        avg_rank=0.5,
        ml_edge_score=12,
        technical_score=14,
        chip_score=20,
        fundamental_score=8,
        score_v2_final_score=66,
    )

    assert weak["status"] == "loaded"
    assert strong["status"] == "loaded"
    assert strong["win_rate"] > weak["win_rate"]
    assert strong["trade_expected_return_net_pct"] > weak["trade_expected_return_net_pct"]
    assert strong["cold_start_policy"]["inputs"]["score_v2_final_score"] == 66


def test_build_s12_trade_ev_from_structure_applies_s12_context_haircuts():
    base = build_s12_trade_ev_from_structure(
        symbol="6257",
        entry_price=100,
        stop_price=96,
        target1_price=106,
        target2_price=112,
        avg_rank=0.72,
        ml_edge_score=18,
        technical_score=17,
        chip_score=28,
        fundamental_score=15,
        score_v2_final_score=66,
        roundtrip_cost_bps=0,
        s12_context={
            "vwap_fast_acceptance": True,
            "vwap_slow_context": "supportive",
            "htf_hard_block": False,
        },
    )
    haircut = build_s12_trade_ev_from_structure(
        symbol="6257",
        entry_price=100,
        stop_price=96,
        target1_price=106,
        target2_price=112,
        avg_rank=0.72,
        ml_edge_score=18,
        technical_score=17,
        chip_score=28,
        fundamental_score=15,
        score_v2_final_score=66,
        roundtrip_cost_bps=0,
        s12_context={
            "vwap_fast_acceptance": True,
            "vwap_slow_context": "overhead_supply",
            "equity_mutation_risk_haircuts": "1h_short_risk_haircut|slow_vwap_overhead_supply_haircut",
            "htf_hard_block": False,
        },
    )

    assert base["status"] == "loaded"
    assert haircut["status"] == "loaded"
    assert haircut["trade_expected_return_net_pct"] < base["trade_expected_return_net_pct"]
    assert haircut["s12_entry_context"]["vwap_slow_context"] == "overhead_supply"
    assert "1h_short_risk_haircut" in haircut["cold_start_policy"]["s12_context_haircuts"]


def test_build_s12_trade_ev_from_structure_fails_closed_on_s12_htf_hard_block():
    ev = build_s12_trade_ev_from_structure(
        symbol="6257",
        entry_price=100,
        stop_price=96,
        target1_price=106,
        target2_price=112,
        s12_context={"htf_hard_block": True},
    )

    assert ev["status"] == "invalid_structure"
    assert ev["trade_expected_return_net_pct"] is None
    assert ev["trade_expected_return_source"] == "s12_structural_cold_start_ev_htf_hard_block"
    assert ev["s12_entry_context"]["htf_hard_block"] is True


def test_build_s12_trade_ev_from_structure_fails_closed_without_target():
    ev = build_s12_trade_ev_from_structure(
        symbol="8091",
        entry_price=100,
        stop_price=96,
        target1_price=None,
        target2_price=None,
    )

    assert ev["status"] == "missing_structure"
    assert ev["trade_expected_return_net_pct"] is None
    assert ev["trade_expected_return_source"] == "s12_structural_cold_start_ev_missing_structure_target"
