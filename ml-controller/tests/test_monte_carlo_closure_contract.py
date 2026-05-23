from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


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
