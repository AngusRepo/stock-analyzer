from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_result_store import build_replay_backtest_insert


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

    assert "INSERT OR REPLACE INTO backtest_results" in sql
    assert params[0] == "2026-04-26"
    assert params[1] == "replay_mode_b"
    raw = json.loads(params[-1])
    assert raw["mode"] == "B"
    assert raw["all_returns"] == [0.03, -0.01]
    assert raw["all_regimes"] == ["green", "red"]
    assert raw["partition_returns"] == [0.01, 0.02]
    assert raw["absolute_confidence"] == "moderate"
    assert raw["parity_audit"] == parity_audit
    assert raw["validation_packet"]["decision"] == "PASS"
    assert raw["metric_explanations"][0]["metric"] == "sharpe"
    assert raw["strategy_lab_record"]["schema_version"] == "strategy-lab-record-v1"
    assert raw["walk_forward"]["windows"] == 6
