from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from services.backtest_service import _attach_entry_regimes


def test_monte_carlo_router_defaults_to_auto_method_for_closed_loop():
    router = (ROOT / "routers" / "backtest.py").read_text(encoding="utf-8")

    assert "method: Optional[str] = Query(default=None" in router
    assert "method={method or 'auto'}" in router
    assert 'default="block_bootstrap"' not in router


def test_monte_carlo_service_fails_closed_when_backtest_regimes_missing():
    service = (ROOT / "services" / "monte_carlo_service.py").read_text(encoding="utf-8")

    assert 'BACKTEST_REGIME_CLOSED_LOOP_MISSING = "backtest_regime_closed_loop_missing"' in service
    assert '"required_backtest_fields": ["all_regimes", "trades[].entry_regime"]' in service
    assert '"next_action": "rerun /backtest/run with regime-aware raw_results before Monte Carlo"' in service


def test_backtest_service_attaches_entry_regimes_for_mc_closure():
    trades = [
        {"symbol": "2330", "entry_date": "2026-05-20", "profit_ratio": 0.02},
        {"symbol": "2454", "entry_date": "2026-05-21", "profit_ratio": -0.03},
        {"symbol": "2317", "entry_date": "2026-05-23", "profit_ratio": 0.01},
    ]
    regimes = {"2026-05-20": "green", "2026-05-22": "red"}

    counts = _attach_entry_regimes(trades, regimes, sorted(regimes))

    assert [trade["entry_regime"] for trade in trades] == ["green", "green", "red"]
    assert counts == {"green": 2, "red": 1}


def test_backtest_service_persists_regime_arrays_for_mc_closure():
    service = (ROOT / "services" / "backtest_service.py").read_text(encoding="utf-8")

    assert "all_regimes" in service
    assert "regime_counts" in service
    assert "entry_regime" in service
    assert "regime_closed_loop" in service
