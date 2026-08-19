from __future__ import annotations

import json
import sys
import pytest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_result_store import build_replay_backtest_insert, persist_replay_backtest
from services.backtest_trade_evidence import (
    decode_backtest_portfolio_return_evidence,
    decode_backtest_trade_evidence,
    resolve_backtest_evidence_run_date,
    canonical_weekly_evidence_error,
)


def _trade(symbol: str, pnl: float, regime: str):
    return SimpleNamespace(
        symbol=symbol,
        entry_date="2026-04-01",
        exit_date="2026-04-03",
        entry_price=100.0,
        exit_price=103.0,
        shares=1000,
        profit_ratio=pnl,
        exit_reason="TP1",
        days_held=2,
        entry_regime=regime,
    )


def test_build_replay_backtest_insert_preserves_mode_b_and_regime_arrays():
    metrics = SimpleNamespace(
        mode="B",
        start_date="2026-01-01",
        end_date="2026-04-01",
        total_trades=2,
        win_rate=0.5,
        sharpe=1.2,
        sortino=1.5,
        calmar=0.8,
        max_drawdown=0.12,
        cagr=0.22,
        profit_factor=1.4,
        expectancy=0.01,
        per_regime={"green": {"trades": 1, "return": 0.03}},
        realism_warnings=[],
        absolute_confidence="moderate",
        sanity_flags=[],
        partition_returns=[0.01, 0.02],
        initial_capital=1_000_000.0,
        equity_curve=[
            ("2026-04-01", 1_010_000.0),
            ("2026-04-02", 999_900.0),
            ("2026-04-03", 1_019_898.0),
        ],
        trades=[_trade("2330", 0.03, "green"), _trade("2317", -0.01, "red")],
    )

    parity_audit = {
        "worker_parity": {
            "decision": "PASS",
            "drift_rate": 0.0,
            "failed": 0,
            "total": 12,
        }
    }

    sql, params = build_replay_backtest_insert(
        metrics,
        run_date="2026-04-26",
        parity_audit=parity_audit,
        validation_packet={"schema_version": "validation-governance-packet-v1", "decision": "PASS"},
        metric_explanations=[{"metric": "sharpe", "meaning_zh": "風險調整後報酬"}],
        strategy_lab_record={"schema_version": "strategy-lab-record-v1", "decision": "PASS"},
        walk_forward={"passed": True, "windows": 6},
    )

    assert "INSERT OR IGNORE INTO backtest_results" in sql
    assert params[0] == "2026-04-26"
    assert params[1] == "replay_mode_b"
    raw = json.loads(params[-1])
    assert raw["mode"] == "B"
    evidence = decode_backtest_trade_evidence(raw)
    assert [trade["profit_ratio"] for trade in evidence] == [0.03, -0.01]
    assert [trade["entry_regime"] for trade in evidence] == ["green", "red"]
    portfolio = decode_backtest_portfolio_return_evidence(raw)
    assert [round(row["portfolio_return"], 6) for row in portfolio] == [0.01, -0.01, 0.02]
    assert raw["trades_complete"] is True
    assert raw["partition_returns"] == [0.01, 0.02]
    assert raw["absolute_confidence"] == "moderate"
    assert raw["parity_audit"] == parity_audit
    assert raw["validation_packet"]["decision"] == "PASS"
    assert raw["metric_explanations"][0]["metric"] == "sharpe"
    assert raw["strategy_lab_record"]["schema_version"] == "strategy-lab-record-v1"
    assert raw["walk_forward"]["windows"] == 6


def test_backtest_evidence_can_grow_past_default_limit_without_sampling_exact_fields():
    trades = [_trade(f"{index:04d}", 0.01 if index % 2 else -0.005, "green") for index in range(500)]
    start = date(2024, 1, 1)
    equity_curve = [
        ((start + timedelta(days=index)).isoformat(), 1_000_000.0 * (1.0002 ** (index + 1)))
        for index in range(875)
    ]
    metrics = SimpleNamespace(
        mode="B",
        start_date="2026-01-01",
        end_date="2026-08-16",
        total_trades=len(trades),
        win_rate=0.5,
        sharpe=1.0,
        sortino=1.2,
        calmar=0.8,
        max_drawdown=0.12,
        cagr=0.18,
        profit_factor=1.1,
        expectancy=0.002,
        per_regime={},
        realism_warnings=[],
        absolute_confidence="moderate",
        sanity_flags=[],
        partition_returns=[],
        initial_capital=1_000_000.0,
        equity_curve=equity_curve,
        trades=trades,
    )

    _, params = build_replay_backtest_insert(
        metrics,
        run_date="2026-08-16",
    )

    encoded = params[-1]
    raw = json.loads(encoded)
    assert len(encoded.encode("utf-8")) < 1_000_000
    evidence = decode_backtest_trade_evidence(raw)
    assert [trade["profit_ratio"] for trade in evidence] == [trade.profit_ratio for trade in trades]
    assert [trade["entry_regime"] for trade in evidence] == [trade.entry_regime for trade in trades]
    assert len(evidence) == len(trades)
    portfolio = decode_backtest_portfolio_return_evidence(raw)
    assert len(portfolio) == len(equity_curve)
    assert all(round(row["portfolio_return"], 7) == 0.0002 for row in portfolio)
    assert len(raw["trades"]) == 100
    assert raw["trades_complete"] is False


def test_historical_backtest_consumers_preserve_expected_run_date():
    assert resolve_backtest_evidence_run_date("backtest", "2026-08-16", "2026-08-18") == "2026-08-16"
    assert resolve_backtest_evidence_run_date("paper", None, "2026-08-18") == "2026-08-18"
    assert resolve_backtest_evidence_run_date("paper", "2026-08-16", "2026-08-18") == "2026-08-16"


def test_canonical_weekly_evidence_clock_is_fail_closed():
    raw = {
        "strategy_lab_record": {
            "evidence_clock": {
                "schema_version": "weekly-evidence-clock-v1",
                "as_of_date": "2026-08-23",
                "data_end_date": "2026-08-21",
                "snapshot_business_date": "2026-08-21",
                "mode": "B",
                "research_data_source": "snapshot",
                "evidence_scope": "canonical_current",
                "production_effect": True,
                "look_ahead_check": "PASS",
            }
        }
    }

    assert canonical_weekly_evidence_error(raw, "2026-08-23") is None
    raw["strategy_lab_record"]["evidence_clock"]["data_end_date"] = "2026-08-24"
    assert canonical_weekly_evidence_error(raw, "2026-08-23") == (
        "canonical_weekly_evidence_lookahead_detected:data_end_date"
    )

def _minimal_metrics_for_persist():
    return SimpleNamespace(
        mode="B",
        start_date="2026-08-01",
        end_date="2026-08-14",
        total_trades=1,
        win_rate=1.0,
        sharpe=1.0,
        sortino=1.0,
        calmar=1.0,
        max_drawdown=0.1,
        cagr=0.1,
        profit_factor=2.0,
        expectancy=0.01,
        per_regime={},
        realism_warnings=[],
        absolute_confidence="moderate",
        sanity_flags=[],
        partition_returns=[],
        initial_capital=1_000_000.0,
        equity_curve=[("2026-08-14", 1_010_000.0)],
        trades=[_trade("2330", 0.01, "green")],
    )


def test_backtest_persist_is_idempotent_only_for_identical_payload(monkeypatch):
    import services.backtest_result_store as store

    metrics = _minimal_metrics_for_persist()
    _, params = build_replay_backtest_insert(metrics, run_date="2026-08-23")
    class FakeResearchClient:
        def query(self, *_args, **_kwargs):
            return [{'id': 7, 'raw_results': params[-1]}]

        def execute(self, *_args, **_kwargs):
            raise AssertionError('must not write')

    monkeypatch.setattr(store, 'client_for_domain', lambda domain: FakeResearchClient())

    result = persist_replay_backtest(metrics, run_date="2026-08-23")

    assert result["idempotent"] is True
    assert result["rows_written"] == 0


def test_backtest_persist_rejects_immutable_payload_conflict(monkeypatch):
    import services.backtest_result_store as store

    metrics = _minimal_metrics_for_persist()
    class FakeResearchClient:
        def query(self, *_args, **_kwargs):
            return [{'id': 8, 'raw_results': 'different'}]

    monkeypatch.setattr(store, 'client_for_domain', lambda domain: FakeResearchClient())

    with pytest.raises(RuntimeError, match="immutable_backtest_evidence_conflict"):
        persist_replay_backtest(metrics, run_date="2026-08-23")
