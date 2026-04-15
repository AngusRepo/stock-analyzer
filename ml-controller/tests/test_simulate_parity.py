"""
test_simulate_parity.py — parity test for _trade_simulator.simulate_trade

Compares Python port output against Worker simulateTrade endpoint
(/api/admin/test/simulate-trade).

Run modes:
  Local only:  pytest tests/test_simulate_parity.py
  Cross-runtime: WORKER_URL=https://... STOCKVISION_AUTH_TOKEN=... pytest

Cross-runtime requires worker deployed with Phase 5.2 endpoint.
"""
import os
import sys
from pathlib import Path

# Allow running from ml-controller/ directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from services._trade_simulator import simulate_trade


# ── Fixtures ──────────────────────────────────────────────────────────────────
def _bar(d: str, o: float, h: float, lo: float, c: float) -> dict:
    return {"date": d, "open": o, "high": h, "low": lo, "close": c}


FIXTURES = [
    # 1) LONG hit_target1 then continue, hit_target2 same day
    {
        "name": "long_hit_t2_immediate",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [_bar("d1", 100, 112, 99, 111)],
        },
    },
    # 2) LONG hit_target1 day1, hit_target2 day2
    {
        "name": "long_t1_then_t2",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [
                _bar("d1", 100, 106, 99, 105),
                _bar("d2", 105, 111, 104, 110),
            ],
        },
    },
    # 3) LONG hit_stop day1, never reaches target
    {
        "name": "long_hit_stop_day1",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [_bar("d1", 100, 102, 94, 96)],
        },
    },
    # 4) LONG hit_t1 day1, then drops below stop day3 — stop disabled, expire
    {
        "name": "long_t1_then_drop_no_stop",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [
                _bar("d1", 100, 105, 99, 105),
                _bar("d2", 105, 106, 96, 97),
                _bar("d3", 97, 98, 90, 92),
            ],
        },
    },
    # 5) LONG expired — neither target nor stop hit
    {
        "name": "long_expired_flat",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [
                _bar("d1", 100, 102, 99, 101),
                _bar("d2", 101, 103, 100, 102),
                _bar("d3", 102, 104, 101, 103),
                _bar("d4", 103, 104, 102, 104),
                _bar("d5", 104, 104, 103, 104),
            ],
        },
    },
    # 6) SHORT hit_target1 then hit_target2
    {
        "name": "short_t1_then_t2",
        "args": {
            "direction": "down", "entry": 100.0, "stop": 105.0,
            "target1": 95.0, "target2": 90.0,
            "bars": [
                _bar("d1", 100, 101, 94, 95),
                _bar("d2", 95, 96, 89, 90),
            ],
        },
    },
    # 7) SHORT hit_stop day1
    {
        "name": "short_hit_stop_day1",
        "args": {
            "direction": "down", "entry": 100.0, "stop": 105.0,
            "target1": 95.0, "target2": 90.0,
            "bars": [_bar("d1", 100, 106, 99, 105)],
        },
    },
    # 8) SHORT t1 then bounce above stop — stop disabled, expire
    {
        "name": "short_t1_then_bounce",
        "args": {
            "direction": "down", "entry": 100.0, "stop": 105.0,
            "target1": 95.0, "target2": 90.0,
            "bars": [
                _bar("d1", 100, 101, 94, 95),
                _bar("d2", 95, 107, 94, 106),
            ],
        },
    },
    # 9) LONG hit_t2 in single big bar (gap up)
    {
        "name": "long_gap_up_hit_t2",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 98.0,
            "target1": 102.0, "target2": 105.0,
            "bars": [_bar("d1", 100, 108, 99, 107)],
        },
    },
    # 10) LONG single bar — both target1 + stop in same bar (target wins per worker logic)
    {
        "name": "long_target_and_stop_same_bar",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [_bar("d1", 100, 106, 94, 100)],
        },
    },
    # 11) LONG bars empty — expire at entry, no PnL
    {
        "name": "long_empty_bars",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [],
        },
    },
    # 12) LONG zero-risk (stop == entry)
    {
        "name": "long_zero_risk",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 100.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [_bar("d1", 100, 106, 100, 105)],
        },
    },
    # 13) LONG slow grind to target1 day5
    {
        "name": "long_slow_grind_t1",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 95.0,
            "target1": 105.0, "target2": 110.0,
            "bars": [
                _bar("d1", 100, 101, 99, 101),
                _bar("d2", 101, 102, 100, 102),
                _bar("d3", 102, 103, 101, 103),
                _bar("d4", 103, 104, 102, 104),
                _bar("d5", 104, 105, 103, 105),
            ],
        },
    },
    # 14) SHORT slow grind to target1
    {
        "name": "short_slow_grind_t1",
        "args": {
            "direction": "down", "entry": 100.0, "stop": 105.0,
            "target1": 95.0, "target2": 90.0,
            "bars": [
                _bar("d1", 100, 101, 99, 99),
                _bar("d2", 99, 100, 97, 97),
                _bar("d3", 97, 98, 96, 96),
                _bar("d4", 96, 96, 95, 95),
            ],
        },
    },
    # 15) LONG MAE/MFE tracking (whipsaw)
    {
        "name": "long_whipsaw_mae_mfe",
        "args": {
            "direction": "up", "entry": 100.0, "stop": 90.0,
            "target1": 110.0, "target2": 115.0,
            "bars": [
                _bar("d1", 100, 104, 96, 102),
                _bar("d2", 102, 106, 92, 95),
                _bar("d3", 95, 108, 91, 107),
            ],
        },
    },
]


# ── Local-only test ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f["name"])
def test_simulate_trade_runs(fixture):
    """Smoke test: every fixture must run without exception and return a valid outcome"""
    result = simulate_trade(**fixture["args"])
    assert result.outcome in ("expired", "hit_target1", "hit_target2", "hit_stop")
    assert isinstance(result.trade_pnl_pct, float)
    assert isinstance(result.trade_pnl_r, float)


# ── Cross-runtime parity test ─────────────────────────────────────────────────
@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f["name"])
def test_simulate_trade_parity(fixture):
    """Compare Python output to Worker endpoint output. Skipped if env vars missing."""
    worker_url = os.environ.get("WORKER_URL")
    auth_token = os.environ.get("STOCKVISION_AUTH_TOKEN")
    if not worker_url or not auth_token:
        pytest.skip("WORKER_URL + STOCKVISION_AUTH_TOKEN required for parity test")

    import httpx
    py_result = simulate_trade(**fixture["args"])
    resp = httpx.post(
        f"{worker_url.rstrip('/')}/api/admin/test/simulate-trade",
        headers={"Authorization": f"Bearer {auth_token}"},
        json=fixture["args"],
        timeout=30,
    )
    assert resp.status_code == 200, f"worker returned {resp.status_code}: {resp.text}"
    ts = resp.json()

    # Worker uses tradePnlPct/tradePnlR/maxFavorable/maxAdverse camelCase
    assert py_result.outcome == ts["outcome"], (
        f"outcome mismatch in {fixture['name']}: py={py_result.outcome} ts={ts['outcome']}"
    )
    assert abs(py_result.trade_pnl_pct - ts["tradePnlPct"]) < 1e-4, (
        f"trade_pnl_pct mismatch in {fixture['name']}: "
        f"py={py_result.trade_pnl_pct} ts={ts['tradePnlPct']}"
    )
    assert abs(py_result.trade_pnl_r - ts["tradePnlR"]) < 1e-2, (
        f"trade_pnl_r mismatch in {fixture['name']}: "
        f"py={py_result.trade_pnl_r} ts={ts['tradePnlR']}"
    )
    assert abs(py_result.max_favorable - ts["maxFavorable"]) < 1e-4, (
        f"max_favorable mismatch in {fixture['name']}: "
        f"py={py_result.max_favorable} ts={ts['maxFavorable']}"
    )
    assert abs(py_result.max_adverse - ts["maxAdverse"]) < 1e-4, (
        f"max_adverse mismatch in {fixture['name']}: "
        f"py={py_result.max_adverse} ts={ts['maxAdverse']}"
    )
