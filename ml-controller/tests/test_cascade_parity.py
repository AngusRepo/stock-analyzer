"""Exit cascade parity: backtest_engine.check_exit_pointwise vs Worker paperExitPolicy.checkExitConditions.

The Worker side runs in-process through `node --import tsx` with the same call shape as
POST /api/admin/test/exit-cascade (worker/src/routes/adminParityRoutes.ts): the champion
trading config with the Python ExitParams copied into `exit`, then categorizeExitReason.
Without node or the Worker's tsx install the TS comparison skips with the reason; the
Python-only expectations still run.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from services.backtest_engine import (
    ExitParams,
    check_exit_pointwise,
)

WORKER_DIR = Path(__file__).resolve().parents[2] / "worker"


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures — each exercises one cascade layer
# ═══════════════════════════════════════════════════════════════════════════════

BASE_POSITION = {
    "symbol": "2330",
    "shares": 2000,
    "avg_cost": 100.0,
    "entry_price": 100.0,
    "initial_stop": 95.0,
    "trailing_stop": 95.0,
    "highest_since_entry": 100.0,
    "tp1_price": 103.0,
    "tp2_price": 106.0,
    "tp1_hit": 0,
    "original_shares": 2000,
    "entry_date": "2024-01-15",
    "stop_multiplier": 2.0,
    "_days_since_entry": 5,  # Sprint 6a.7 deterministic override
}


FIXTURES = [
    # ── Layer 1: Hard stop (-12%) ────────────────────────────────────────
    {
        "id": "L1_hard_stop",
        "position": {**BASE_POSITION},
        "current_price": 85.0,   # -15% → below hardStopPct=-0.10
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "full_sell",
        "expected_category": "HardStop",
    },
    # ── Layer 2: ATR initial stop (not hard stop) ────────────────────────
    {
        "id": "L2_init_stop",
        "position": {**BASE_POSITION},
        "current_price": 94.0,   # -6%, above hardStop but <= initial_stop
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "full_sell",
        "expected_category": "InitStop",
    },
    # ── Layer 3: ML SELL EOD only ────────────────────────────────────────
    {
        "id": "L3_ml_sell_eod",
        "position": {**BASE_POSITION},
        "current_price": 101.5,  # no other trigger
        "atr14": 2.0,
        "has_ml_sell": True,
        "is_eod": True,
        "expected_action": "full_sell",
        "expected_category": "ML_SELL",
    },
    # ── Layer 3 intraday → should NOT trigger ML SELL (hold instead) ────
    # Note: current_price 101.5 > highest (100.0) triggers trailing update,
    # so category is HoldTrailingUpdate — the critical assertion is that
    # action=='hold' (not 'full_sell'), confirming L3 skipped outside EOD.
    {
        "id": "L3_ml_sell_intraday_skipped",
        "position": {**BASE_POSITION},
        "current_price": 101.5,
        "atr14": 2.0,
        "has_ml_sell": True,
        "is_eod": False,  # intraday
        "expected_action": "hold",
        "expected_category": "HoldTrailingUpdate",
    },
    # ── Layer 4: Trailing stop (set trailing > initial) ──────────────────
    {
        "id": "L4_trail_stop",
        "position": {**BASE_POSITION, "trailing_stop": 98.0, "highest_since_entry": 102.0},
        "current_price": 97.0,   # below trailing (98) but above initial (95)
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "full_sell",
        "expected_category": "TrailStop",
    },
    # ── Layer 5: TP1 partial sell ────────────────────────────────────────
    {
        "id": "L5_tp1_partial",
        "position": {**BASE_POSITION, "shares": 2000, "original_shares": 2000},
        "current_price": 103.5,  # above tp1=103
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "partial_sell",
        "expected_category": "TP1",
        "expected_sell_shares": 1000,  # floor(2000*0.5/1000)*1000
    },
    # ── Layer 5: TP1 single-lot → full sell ──────────────────────────────
    {
        "id": "L5_tp1_single_lot_full",
        "position": {**BASE_POSITION, "shares": 1000, "original_shares": 1000},
        "current_price": 103.5,
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "full_sell",
        "expected_category": "TP1",
    },
    # ── Layer 6: TP2 after TP1 hit ───────────────────────────────────────
    {
        "id": "L6_tp2_after_tp1",
        "position": {**BASE_POSITION, "tp1_hit": 1},
        "current_price": 107.0,  # above tp2=106
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "full_sell",
        "expected_category": "TP2",
    },
    # ── Layer 7: Time stop (days > 30 + profit > 0.5%) ──────────────────
    {
        "id": "L7_time_stop",
        "position": {**BASE_POSITION, "_days_since_entry": 31},
        "current_price": 101.0,  # +1% profit, no other trigger
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "full_sell",
        "expected_category": "TimeStop",
    },
    # ── Layer 7: Time stop intraday → should NOT trigger ────────────────
    {
        "id": "L7_time_stop_intraday_skipped",
        "position": {**BASE_POSITION, "_days_since_entry": 31},
        "current_price": 101.0,
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": False,
        "expected_action": "hold",
        "expected_category": "HoldTrailingUpdate",  # trailing updates at every call
    },
    # ── Hold with trailing update ────────────────────────────────────────
    {
        "id": "hold_trailing_update",
        "position": {**BASE_POSITION, "highest_since_entry": 100.0},
        "current_price": 101.0,
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "hold",
        "expected_category": "HoldTrailingUpdate",
    },
    # ── Hold no trigger at all ───────────────────────────────────────────
    {
        "id": "hold_no_trigger",
        "position": {**BASE_POSITION, "highest_since_entry": 100.0, "trailing_stop": 98.5},
        "current_price": 100.0,  # same as highest, no trailing change
        "atr14": 2.0,
        "has_ml_sell": False,
        "is_eod": True,
        "expected_action": "hold",
        "expected_category": "HoldNoTrigger",
    },
]


# ═══════════════════════════════════════════════════════════════════════════════
# Worker TS bridge
# ═══════════════════════════════════════════════════════════════════════════════

# Fixture ids whose reason_category differs from the Worker today (action and sell
# shares still match and stay strict). Strict xfail: remove the entry once both converge.
_HOLD_UPDATE_DRIFT = (
    "Python hold is a chandelier 'trailing update' (HoldTrailingUpdate); TS hold is "
    "'fixed stop / high-water mark update', which its own categorizer files as HoldNoTrigger"
)
KNOWN_CATEGORY_DRIFT: dict[str, str] = {
    "L3_ml_sell_intraday_skipped": _HOLD_UPDATE_DRIFT,
    "L7_time_stop_intraday_skipped": _HOLD_UPDATE_DRIFT,
    "hold_trailing_update": _HOLD_UPDATE_DRIFT,
}

_TS_EXIT_SCRIPT = r"""
import { readFileSync } from 'node:fs';
import exitPolicy from './src/lib/paperExitPolicy.ts';
import tradingConfig from './src/lib/tradingConfig.ts';
const { checkExitConditions, categorizeExitReason } = exitPolicy;
const { buildChampionTradingConfig } = tradingConfig;
const { exit, cases } = JSON.parse(readFileSync(0, 'utf8'));
const base = buildChampionTradingConfig({});
const cfg = { ...base, exit: { ...base.exit, ...exit } };
const out = {};
for (const f of cases) {
  // checkExitConditions counts days from Date.now(); back-date by whole days plus one hour.
  const entry_date = new Date(Date.now() - f.days * 86400000 - 3600000).toISOString();
  const d = checkExitConditions({ ...f.position, entry_date }, f.currentPrice, f.atr14, f.hasMlSell, f.isEOD, cfg);
  out[f.id] = { action: d.action, reason: d.reason, reason_category: categorizeExitReason(d.reason), sellShares: d.sellShares ?? null };
}
console.log(JSON.stringify(out));
"""


def _exit_override(exit_p: ExitParams) -> dict:
    """ExitParams -> trading:config.exit fields (inverse of ExitParams.from_trading_config)."""
    return {
        "hardStopPct": exit_p.hard_stop_pct,
        "fallbackInitStopMult": exit_p.fallback_init_stop_mult,
        "fallbackTp1Mult": exit_p.fallback_tp1_mult,
        "fallbackTp2Mult": exit_p.fallback_tp2_mult,
        "tp1SellRatio": exit_p.tp1_sell_ratio,
        "timeStopDays": exit_p.time_stop_days,
        "timeStopMinProfit": exit_p.time_stop_min_profit,
    }


def _python_decision(f: dict, exit_p: ExitParams):
    return check_exit_pointwise(
        pos_dict=f["position"],
        current_price=f["current_price"],
        atr14=f["atr14"],
        has_ml_sell=f["has_ml_sell"],
        is_eod=f["is_eod"],
        exit_p=exit_p,
    )


@pytest.fixture(scope="module")
def ts_decisions() -> dict:
    if shutil.which("node") is None:
        pytest.skip("node not on PATH: Worker checkExitConditions cannot run")
    if not (WORKER_DIR / "node_modules" / "tsx").is_dir():
        pytest.skip(f"tsx not installed under {WORKER_DIR}/node_modules (run npm ci in worker)")
    cases = []
    for f in FIXTURES:
        position = {k: v for k, v in f["position"].items() if k != "_days_since_entry"}
        cases.append({
            "id": f["id"], "position": position, "days": f["position"].get("_days_since_entry", 5),
            "currentPrice": f["current_price"], "atr14": f["atr14"],
            "hasMlSell": f["has_ml_sell"], "isEOD": f["is_eod"],
        })
    payload = json.dumps({"exit": _exit_override(ExitParams()), "cases": cases})
    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", _TS_EXIT_SCRIPT],
        cwd=WORKER_DIR, input=payload, capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError("Worker TS bridge failed:\n" + result.stdout + result.stderr)
    return json.loads(result.stdout.strip().splitlines()[-1])


# ═══════════════════════════════════════════════════════════════════════════════
# Tests
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("f", FIXTURES, ids=[f["id"] for f in FIXTURES])
def test_python_cascade_matches_expected_layer(f):
    decision = _python_decision(f, ExitParams())
    assert decision.action == f["expected_action"], decision.reason
    assert decision.reason_category == f["expected_category"], decision.reason
    if "expected_sell_shares" in f:
        assert decision.sell_shares == f["expected_sell_shares"]


@pytest.mark.parametrize("f", FIXTURES, ids=[f["id"] for f in FIXTURES])
def test_python_action_and_sell_shares_match_worker_ts(f, ts_decisions):
    py = _python_decision(f, ExitParams())
    ts = ts_decisions[f["id"]]
    assert (py.action, py.sell_shares) == (ts["action"], ts["sellShares"]), (
        f"py reason={py.reason!r} ts reason={ts['reason']!r}"
    )


@pytest.mark.parametrize("f", [
    pytest.param(f, id=f["id"], marks=pytest.mark.xfail(strict=True, raises=AssertionError, reason=KNOWN_CATEGORY_DRIFT[f["id"]]))
    if f["id"] in KNOWN_CATEGORY_DRIFT else pytest.param(f, id=f["id"])
    for f in FIXTURES
])
def test_python_reason_category_matches_worker_ts(f, ts_decisions):
    py = _python_decision(f, ExitParams())
    ts = ts_decisions[f["id"]]
    assert py.reason_category == ts["reason_category"], f"py reason={py.reason!r} ts reason={ts['reason']!r}"
