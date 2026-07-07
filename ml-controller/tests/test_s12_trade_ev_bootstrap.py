from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.s12_trade_ev_bootstrap import S12TradeEvBootstrapProvider, load_s12_replay_trade_rows  # noqa: E402


def _row(
    symbol: str,
    prediction_date: str,
    pnl: float,
    *,
    market: str = "TWSE",
    bucket: str = "breakout",
    s12: bool = True,
    trade_signal: str = "buy",
) -> dict:
    forecast_data = {
        "stock_meta": {"market_segment": "LISTED" if market == "TWSE" else "OTC"},
        "alpha_context": {"edge_bucket": bucket},
    }
    if s12:
        forecast_data["s12_trade_ev"] = {
            "schema_version": "s12-trade-ev-v1",
            "status": "loaded",
            "semantic": "trade_expected_return_not_5bar_close_forecast",
            "trade_expected_return_net_pct": pnl,
            "trade_expected_return_source": "s12_structural_exit_verified",
        }
    return {
        "symbol": symbol,
        "market": market,
        "prediction_date": prediction_date,
        "trade_signal": trade_signal,
        "trade_pnl_pct": pnl,
        "trade_pnl_r": pnl / 0.04,
        "trade_outcome": "tp1" if pnl > 0 else "structure_stop",
        "max_favorable_pct": max(pnl, 0.0),
        "max_adverse_pct": min(pnl, 0.0),
        "forecast_data": json.dumps(forecast_data),
    }


def test_load_s12_replay_trade_rows_enforces_strict_pre_run_date_query():
    captured: dict = {}

    def fake_query(sql, params=None, **_kwargs):
        captured["sql"] = sql
        captured["params"] = params
        return []

    load_s12_replay_trade_rows(run_date="2026-07-03", query_fn=fake_query)

    assert "date(p.prediction_date) < date(?)" in captured["sql"]
    assert "lower(COALESCE(p.trade_signal, '')) IN ('buy', 'strong_buy')" in captured["sql"]
    assert "p.forecast_data LIKE '%\"s12_trade_ev\"%'" in captured["sql"]
    assert captured["params"][0] == "2026-07-03"


def test_load_s12_replay_trade_rows_accepts_dedicated_replay_outcomes():
    calls: list[str] = []

    def fake_query(sql, params=None, **_kwargs):
        calls.append(sql)
        if "FROM s12_replay_trade_outcomes" in sql:
            return [
                {
                    "symbol": "8091",
                    "market": "TWSE",
                    "trade_date": "2026-07-02",
                    "assessment_state": "reaction_ready",
                    "setup_id": "8091:setup",
                    "entry_price": 100,
                    "stop_price": 96,
                    "pnl_pct": 0.04,
                    "trade_pnl_r": 1.0,
                    "max_favorable_pct": 0.06,
                    "max_adverse_pct": -0.01,
                    "bars_to_exit": 5,
                    "exit_reason": "tp1",
                    "sample_eligible": 1,
                    "source": "s12_intraday_structure_replay_v1",
                    "detail_json": json.dumps({"conservative_intrabar_order": "stop_before_target"}),
                }
            ]
        return []

    rows = load_s12_replay_trade_rows(run_date="2026-07-03", query_fn=fake_query)

    assert any("FROM s12_replay_trade_outcomes" in sql for sql in calls)
    assert any("LEFT JOIN stocks st ON st.symbol = r.symbol" in sql for sql in calls)
    assert rows[0]["symbol"] == "8091"
    assert rows[0]["prediction_date"] == "2026-07-02"
    assert rows[0]["market_segment"] == "TWSE"
    assert rows[0]["trade_pnl_pct"] == pytest.approx(0.04)
    assert json.loads(rows[0]["forecast_data"])["s12_trade_ev"]["status"] == "loaded"


def test_s12_trade_ev_bootstrap_retires_cold_with_dedicated_replay_min_samples():
    rows = []
    for i in range(30):
        rows.append({
            "symbol": "8091",
            "market": "TWSE",
            "prediction_date": f"2026-06-{(i % 20) + 1:02d}",
            "trade_signal": "buy",
            "trade_pnl_pct": 0.04,
            "trade_pnl_r": 1.0,
            "trade_outcome": "tp1",
            "max_favorable_pct": 0.06,
            "max_adverse_pct": -0.01,
            "forecast_data": json.dumps({
                "stock_meta": {"market_segment": "LISTED"},
                "alpha_context": {"edge_bucket": "breakout"},
                "s12_trade_ev": {
                    "schema_version": "s12-trade-ev-v1",
                    "status": "loaded",
                    "semantic": "trade_expected_return_not_5bar_close_forecast",
                    "trade_expected_return_net_pct": 0.04,
                    "trade_expected_return_source": "s12_intraday_structure_replay_v1",
                },
            }),
        })
    provider = S12TradeEvBootstrapProvider(rows, run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row({
        "symbol": "8091",
        "current_price": 100,
        "stop_loss": 96,
        "market_segment": "LISTED",
        "alpha_context": {"edge_bucket": "breakout"},
    })

    assert ev["status"] == "loaded"
    assert ev["source"] == "s12_replay_trade_outcomes:symbol"
    assert ev["sample_policy"] == "verified_s12_buy_trade_outcomes_only"
    assert ev["sampleCount"] == 30
    assert ev.get("cold_start") is None
    assert "replay_bootstrap" not in ev


def test_s12_trade_ev_bootstrap_prefers_market_bucket_before_global():
    rows = [_row("1111", "2026-07-01", 0.02)] * 12
    rows += [_row("2222", "2026-07-01", 0.03)] * 12
    rows += [_row("9999", "2026-07-01", -0.03, market="OTC", bucket="mean_revert")] * 12
    provider = S12TradeEvBootstrapProvider(rows, run_date="2026-07-03", min_samples=20, roundtrip_cost_bps=0)

    ev = provider.build_for_row({
        "symbol": "8091",
        "current_price": 100,
        "stop_loss": 96,
        "market_segment": "LISTED",
        "alpha_context": {"edge_bucket": "breakout"},
    })

    assert ev["status"] == "loaded"
    assert ev["bootstrap_scope"] == "market_segment_alpha_bucket"
    assert ev["sampleCount"] == 24
    assert ev["sample_date_max"] == "2026-07-01"
    assert ev["as_of_guard"] == "prediction_date_strictly_before_run_date"
    assert ev["sample_policy"] == "verified_s12_buy_trade_outcomes_only"
    assert ev["trade_expected_return_net_pct"] == pytest.approx(0.025)
    assert ev["global_direct_ev_owner_allowed"] is False


def test_s12_trade_ev_bootstrap_does_not_use_global_as_direct_ev_owner():
    rows = [_row(f"{1000 + i}", "2026-07-01", 0.02, market="OTC", bucket="mean_revert") for i in range(40)]
    provider = S12TradeEvBootstrapProvider(rows, run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row({
        "symbol": "8091",
        "current_price": 100,
        "stop_loss": 96,
    })

    assert ev["status"] == "loaded"
    assert ev["source"] == "s12_structural_cold_start_ev"
    assert ev["sample_policy"] == "s12_structural_cold_start_no_replay"
    assert ev["replay_bootstrap"]["bootstrap_scope"] == "symbol"
    assert ev["replay_bootstrap"]["sampleCount"] == 0
    assert ev["replay_bootstrap"]["global_sample_count"] == 40
    assert ev["replay_bootstrap"]["global_direct_ev_owner_allowed"] is False
    assert ev["replay_bootstrap"]["trade_expected_return_source"].endswith("_insufficient_samples")


def test_s12_trade_ev_bootstrap_filters_same_day_rows():
    provider = S12TradeEvBootstrapProvider(
        [
            _row("1111", "2026-07-02", 0.02),
            _row("1111", "2026-07-03", 0.99),
        ],
        run_date="2026-07-03",
        min_samples=1,
        roundtrip_cost_bps=0,
    )

    ev = provider.build_for_row({"symbol": "1111", "current_price": 100, "stop_loss": 96})

    assert ev["sampleCount"] == 1
    assert ev["sample_date_max"] == "2026-07-02"
    assert ev["trade_expected_return_net_pct"] == pytest.approx(0.02)


def test_s12_trade_ev_bootstrap_excludes_legacy_non_s12_outcomes():
    rows = [_row("1111", "2026-07-01", -0.10, s12=False)] * 40
    rows += [_row("2222", "2026-07-01", 0.03, s12=True)] * 4
    provider = S12TradeEvBootstrapProvider(rows, run_date="2026-07-03", min_samples=5, roundtrip_cost_bps=0)

    ev = provider.build_for_row({
        "symbol": "8091",
        "current_price": 100,
        "stop_loss": 96,
        "market_segment": "LISTED",
        "alpha_context": {"edge_bucket": "breakout"},
    })

    assert provider.summary()["input_rows"] == 44
    assert provider.summary()["sample_rows"] == 4
    assert provider.summary()["excluded_non_s12_rows"] == 40
    assert ev["status"] == "loaded"
    assert ev["sample_policy"] == "s12_structural_cold_start_no_replay"
    assert ev["s12_structural_targets"]["target1_source"] == "s12_structure_exit_plan.r_multiple_fallback_1r"
    assert ev["s12_structural_targets"]["target2_source"] == "s12_structure_exit_plan.r_multiple_fallback_2r"
    assert ev["replay_bootstrap"]["sampleCount"] == 4
    assert ev["replay_bootstrap"]["trade_expected_return_source"].endswith("_insufficient_samples")


def test_s12_trade_ev_bootstrap_uses_structural_cold_start_when_verified_samples_are_sparse():
    rows = [_row("1111", "2026-07-01", -0.10, s12=False)] * 40
    rows += [_row("2222", "2026-07-01", 0.03, s12=True)] * 4
    provider = S12TradeEvBootstrapProvider(rows, run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row(
        {
            "symbol": "8091",
            "current_price": 100,
            "stop_loss": 96,
            "target1": 101,
            "target2": 102,
            "market_segment": "LISTED",
            "alpha_context": {"edge_bucket": "breakout", "regime": "bull"},
            "ml_score": 18,
            "tech_score": 17,
            "chip_score": 28,
        },
        prediction={
            "ensemble_v2": {"avg_rank": 0.72, "confidence": 0.72},
            "s12_exit": {
                "tp1": {"price": 104, "source": "15m_previous_high"},
                "mainExit": {"price": 108, "source": "1h_supply_zone"},
            },
        },
    )

    assert ev["status"] == "loaded"
    assert ev["source"] == "s12_structural_cold_start_ev"
    assert ev["sample_policy"] == "s12_structural_cold_start_no_replay"
    assert ev["target1_price"] == 104
    assert ev["target2_price"] == 108
    assert ev["s12_structural_targets"]["legacy_target1_ignored"] is True
    assert ev["s12_structural_targets"]["legacy_target2_ignored"] is True
    assert ev["replay_bootstrap"]["sampleCount"] == 4
    assert ev["replay_bootstrap"]["trade_expected_return_source"].endswith("_insufficient_samples")
    assert ev["trade_expected_return_net_pct"] > 0


def test_s12_trade_ev_bootstrap_passes_worker_s12_context_to_cold_start_ev():
    provider = S12TradeEvBootstrapProvider([], run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row(
        {
            "symbol": "6257",
            "current_price": 100,
            "stop_loss": 96,
            "market_segment": "LISTED",
            "alpha_context": {"edge_bucket": "breakout", "regime": "bull"},
            "score": 66,
            "forecast_data": json.dumps({
                "canonical_trade_lifecycle": {
                    "entry": {
                        "s12": {
                            "detail": (
                                "state=reaction_ready;ready=true;entry_archetype=equity_repricing_breakout;"
                                "vwap_fast_acceptance=true;vwap_fast_reasons=session_vwap_above|rolling15m_7_above;"
                                "vwap_slow_context=overhead_supply;"
                                "equity_mutation_risk_haircuts=1h_short_risk_haircut|slow_vwap_overhead_supply_haircut;"
                                "htf_hard_block=false"
                            ),
                            "exitPlan": {
                                "tp1": 106,
                                "tp1Source": "15m_previous_high",
                                "mainExit": 112,
                                "mainExitSource": "vwap_fair_value",
                            },
                        },
                    },
                },
            }),
        },
        prediction={"ensemble_v2": {"avg_rank": 0.72, "confidence": 0.72}},
    )

    assert ev["status"] == "loaded"
    assert ev["source"] == "s12_structural_cold_start_ev"
    assert ev["candidate_s12_entry_context"]["entry_archetype"] == "equity_repricing_breakout"
    assert ev["candidate_s12_entry_context"]["vwap_fast_acceptance"] == "true"
    assert ev["s12_entry_context"]["vwap_fast_acceptance"] is True
    assert ev["s12_entry_context"]["vwap_slow_context"] == "overhead_supply"
    assert ev["s12_entry_context"]["htf_hard_block"] is False
    assert ev["cold_start_policy"]["inputs"]["s12_entry_context"]["vwap_slow_context"] == "overhead_supply"
    assert "1h_short_risk_haircut" in ev["cold_start_policy"]["s12_context_haircuts"]


def test_s12_trade_ev_bootstrap_keeps_setup_ev_but_requires_reaction_ready_execution_gate():
    provider = S12TradeEvBootstrapProvider([], run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row(
        {
            "symbol": "6257",
            "current_price": 100,
            "stop_loss": 96,
            "market_segment": "LISTED",
            "score": 66,
            "forecast_data": json.dumps({
                "canonical_trade_lifecycle": {
                    "entry": {
                        "s12": {
                            "ready": False,
                            "state": "waiting_sweep",
                            "detail": (
                                "state=waiting_sweep;ready=false;entry_archetype=equity_repricing_breakout;"
                                "vwap_fast_acceptance=true;htf_hard_block=false"
                            ),
                            "exitPlan": {
                                "tp1": 106,
                                "tp1Source": "15m_previous_high",
                                "mainExit": 112,
                                "mainExitSource": "vwap_fair_value",
                            },
                        },
                    },
                },
            }),
        },
        prediction={"ensemble_v2": {"avg_rank": 0.72, "confidence": 0.72}},
    )

    assert ev["status"] == "setup_only"
    assert ev["trade_expected_return_net_pct"] is not None
    assert ev["trade_expected_return_source"] == "s12_structural_setup_cold_start_ev"
    assert ev["sample_policy"] == "s12_structural_setup_cold_start_no_replay"
    assert ev["execution_ready"] is False
    assert ev["execution_gate_required"] == "s12_reaction_ready"
    assert ev["execution_blocked_reason"] == "s12_ready_false"
    assert ev["candidate_s12_entry_context"]["state"] == "waiting_sweep"


def test_s12_trade_ev_bootstrap_uses_fundamental_quality_before_score_components_are_rebuilt():
    provider = S12TradeEvBootstrapProvider([], run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row(
        {
            "symbol": "6257",
            "current_price": 100,
            "stop_loss": 96,
            "target1": 106,
            "target2": 112,
            "market_segment": "LISTED",
            "score": 66,
            "fundamental_quality": {"score": 14.2},
            "score_components": {"components": {"fundamentalQuality": 0.0}},
        },
        prediction={"ensemble_v2": {"avg_rank": 0.72, "confidence": 0.72}},
    )

    assert ev["status"] == "loaded"
    assert ev["cold_start_policy"]["inputs"]["fundamental_score"] == pytest.approx(14.2)


def test_s12_trade_ev_bootstrap_prefers_structured_canonical_entry_context():
    provider = S12TradeEvBootstrapProvider([], run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row(
        {
            "symbol": "6257",
            "current_price": 100,
            "stop_loss": 96,
            "market_segment": "LISTED",
            "forecast_data": json.dumps({
                "canonical_trade_lifecycle": {
                    "entry": {
                        "s12": {
                            "entryContext": {
                                "entryArchetype": "equity_repricing_breakout",
                                "vwapFastAcceptance": True,
                                "vwapFastReasons": ["session_vwap_above", "rolling15m_7_above"],
                                "vwapSlowContext": "mixed",
                                "equityMutationRiskHaircuts": ["1h_short_risk_haircut"],
                                "htfHardBlock": False,
                            },
                            "exitPlan": {
                                "tp1": 106,
                                "tp1Source": "15m_previous_high",
                                "mainExit": 112,
                                "mainExitSource": "vwap_fair_value",
                            },
                        },
                    },
                },
            }),
        },
        prediction={"ensemble_v2": {"avg_rank": 0.72, "confidence": 0.72}},
    )

    assert ev["status"] == "loaded"
    assert ev["candidate_s12_entry_context"]["detail_available"] is False
    assert ev["candidate_s12_entry_context"]["vwap_fast_acceptance"] is True
    assert ev["s12_entry_context"]["vwap_fast_acceptance"] is True
    assert ev["s12_entry_context"]["vwap_slow_context"] == "mixed"
    assert "1h_short_risk_haircut" in ev["s12_entry_context"]["equity_mutation_risk_haircuts"]


def test_s12_trade_ev_bootstrap_preserves_vwap_fair_value_target_sources():
    provider = S12TradeEvBootstrapProvider([], run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row(
        {
            "symbol": "8091",
            "current_price": 100,
            "stop_loss": 96,
            "market_segment": "LISTED",
            "alpha_context": {"edge_bucket": "breakout", "regime": "bull"},
        },
        prediction={
            "s12_exit": {
                "tp1": {"price": 104, "source": "vwap_fair_value"},
                "mainExit": {"price": 109, "source": "vwap_fair_value"},
            },
        },
    )

    assert ev["status"] == "loaded"
    assert ev["target1_price"] == 104
    assert ev["target2_price"] == 109
    assert ev["s12_structural_targets"]["target1_declared_source"] == "vwap_fair_value"
    assert ev["s12_structural_targets"]["target2_declared_source"] == "vwap_fair_value"
    assert ev["s12_structural_targets"]["target1_source"].endswith("source=vwap_fair_value")
    assert ev["s12_structural_targets"]["target2_source"].endswith("source=vwap_fair_value")
    assert "vwap_fair_value" in ev["s12_structural_targets"]["target1_policy"]
    assert "vwap_fair_value" in ev["s12_structural_targets"]["target2_policy"]


def test_s12_trade_ev_bootstrap_reads_canonical_lifecycle_vwap_targets():
    provider = S12TradeEvBootstrapProvider([], run_date="2026-07-03", min_samples=30, roundtrip_cost_bps=0)

    ev = provider.build_for_row(
        {
            "symbol": "8091",
            "current_price": 100,
            "stop_loss": 96,
            "forecast_data": json.dumps({
                "canonical_trade_lifecycle": {
                    "entry": {
                        "s12": {
                            "exitPlan": {
                                "tp1": 104,
                                "tp1Source": "15m_previous_high",
                                "mainExit": 109,
                                "mainExitSource": "vwap_fair_value",
                            },
                            "supplyZoneLow": 108,
                            "supplyZoneHigh": 111,
                        },
                    },
                },
            }),
            "market_segment": "LISTED",
            "alpha_context": {"edge_bucket": "breakout", "regime": "bull"},
        },
    )

    assert ev["status"] == "loaded"
    assert ev["target1_price"] == 104
    assert ev["target2_price"] == 109
    assert ev["s12_structural_targets"]["target2_declared_source"] == "vwap_fair_value"
    assert "canonical_trade_lifecycle.entry.s12.exitPlan.mainExit" in ev["s12_structural_targets"]["target2_source"]


def test_s12_trade_ev_bootstrap_excludes_hold_signal_even_with_s12_payload():
    provider = S12TradeEvBootstrapProvider(
        [_row("1111", "2026-07-02", 0.08, trade_signal="hold")] * 10,
        run_date="2026-07-03",
        min_samples=1,
        roundtrip_cost_bps=0,
    )

    ev = provider.build_for_row({"symbol": "1111", "current_price": 100, "stop_loss": 96})

    assert provider.summary()["sample_rows"] == 0
    assert ev["status"] == "loaded"
    assert ev["sample_policy"] == "s12_structural_cold_start_no_replay"
    assert ev["s12_structural_targets"]["target1_source"] == "s12_structure_exit_plan.r_multiple_fallback_1r"
    assert ev["s12_structural_targets"]["target2_source"] == "s12_structure_exit_plan.r_multiple_fallback_2r"
    assert ev["replay_bootstrap"]["sampleCount"] == 0
