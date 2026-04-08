"""
test_cascade_parity.py — Sprint 6a.7 exit cascade parity test

Verifies that backtest_engine.check_exit_pointwise() returns identical
decisions to Worker paper.ts checkExitConditions() for the same inputs.

Two run modes:

  LOCAL mode (--mode local):
    Runs fixture-based test against local Python check_exit_pointwise only.
    Fast, no network, but only catches bugs in the Python port — cannot
    detect drift from the Worker TS version.

  PARITY mode (--mode parity):
    Also POSTs each fixture to Worker /api/admin/test/exit-cascade and
    asserts (action, reason_category, sell_shares) match. Requires:
      - Worker deployed with the /admin/test/exit-cascade endpoint
      - STOCKVISION_AUTH_TOKEN env var set
      - WORKER_URL env var set (e.g. https://stockvision-worker.angus-solo-dev.workers.dev)

Usage:
  python tests/test_cascade_parity.py --mode local
  WORKER_URL=... STOCKVISION_AUTH_TOKEN=... python tests/test_cascade_parity.py --mode parity

Exit code: 0 = all fixtures pass, 1 = any mismatch.

See memory/project_backtest_engine_design_rationale.md section 4 for design.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from services.backtest_engine import (
    ExitParams,
    check_exit_pointwise,
)


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
# Runners
# ═══════════════════════════════════════════════════════════════════════════════

def run_local(exit_p: ExitParams) -> tuple[int, int, list[str]]:
    """Run fixtures against local Python check_exit_pointwise only."""
    passed = 0
    failed = 0
    errors: list[str] = []

    for f in FIXTURES:
        decision = check_exit_pointwise(
            pos_dict=f["position"],
            current_price=f["current_price"],
            atr14=f["atr14"],
            has_ml_sell=f["has_ml_sell"],
            is_eod=f["is_eod"],
            exit_p=exit_p,
        )
        if decision.action != f["expected_action"]:
            failed += 1
            errors.append(
                f"  [{f['id']}] action: expected {f['expected_action']!r}, "
                f"got {decision.action!r} (reason={decision.reason})"
            )
            continue
        if decision.reason_category != f["expected_category"]:
            failed += 1
            errors.append(
                f"  [{f['id']}] category: expected {f['expected_category']!r}, "
                f"got {decision.reason_category!r} (reason={decision.reason})"
            )
            continue
        if "expected_sell_shares" in f:
            if decision.sell_shares != f["expected_sell_shares"]:
                failed += 1
                errors.append(
                    f"  [{f['id']}] sell_shares: expected {f['expected_sell_shares']}, "
                    f"got {decision.sell_shares}"
                )
                continue
        passed += 1

    return passed, failed, errors


def _sync_entry_date(position: dict) -> dict:
    """
    Worker checkExitConditions uses `Date.now() - new Date(entry_date).getTime()`
    for time-stop calculation, so fixture entry_date must be relative to current
    clock. Python check_exit_pointwise honors `_days_since_entry` override.
    Make both paths see the same day count by setting Worker-facing entry_date
    = today - _days_since_entry.
    """
    from datetime import datetime, timedelta
    days = position.get("_days_since_entry", 5)
    synced_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    worker_pos = {**position, "entry_date": synced_date}
    worker_pos.pop("_days_since_entry", None)  # Worker doesn't know this field
    return worker_pos


def run_parity(exit_p: ExitParams, worker_url: str, token: str) -> tuple[int, int, list[str]]:
    """Run fixtures against BOTH local Python and Worker TS, compare results."""
    try:
        import httpx
    except ImportError:
        print("[ERROR] httpx not installed — pip install httpx")
        return 0, len(FIXTURES), ["httpx missing"]

    passed = 0
    failed = 0
    errors: list[str] = []

    endpoint = f"{worker_url.rstrip('/')}/api/admin/test/exit-cascade"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    with httpx.Client(timeout=15.0) as client:
        for f in FIXTURES:
            # Python decision (uses _days_since_entry override)
            py = check_exit_pointwise(
                pos_dict=f["position"],
                current_price=f["current_price"],
                atr14=f["atr14"],
                has_ml_sell=f["has_ml_sell"],
                is_eod=f["is_eod"],
                exit_p=exit_p,
            )

            # Worker TS decision — sync entry_date to match Python's day count
            worker_position = _sync_entry_date(f["position"])
            try:
                resp = client.post(endpoint, headers=headers, json={
                    "position": worker_position,
                    "currentPrice": f["current_price"],
                    "atr14": f["atr14"],
                    "hasMlSell": f["has_ml_sell"],
                    "isEOD": f["is_eod"],
                })
                if resp.status_code != 200:
                    failed += 1
                    errors.append(
                        f"  [{f['id']}] Worker HTTP {resp.status_code}: {resp.text[:200]}"
                    )
                    continue
                ts = resp.json()
            except Exception as e:
                failed += 1
                errors.append(f"  [{f['id']}] Worker request failed: {e}")
                continue

            # Compare action + category + sell_shares
            diffs: list[str] = []
            if py.action != ts.get("action"):
                diffs.append(f"action py={py.action!r} ts={ts.get('action')!r}")
            if py.reason_category != ts.get("reason_category"):
                diffs.append(
                    f"category py={py.reason_category!r} ts={ts.get('reason_category')!r}"
                )
            if py.sell_shares != ts.get("sellShares"):
                diffs.append(
                    f"sellShares py={py.sell_shares} ts={ts.get('sellShares')}"
                )

            if diffs:
                failed += 1
                errors.append(f"  [{f['id']}] DRIFT: {' | '.join(diffs)}")
            else:
                passed += 1

    return passed, failed, errors


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["local", "parity"], default="local")
    args = parser.parse_args()

    exit_p = ExitParams()  # production defaults

    print(f"Running {len(FIXTURES)} cascade fixtures in {args.mode} mode...")
    print()

    if args.mode == "local":
        passed, failed, errors = run_local(exit_p)
    else:
        worker_url = os.environ.get("WORKER_URL", "").strip()
        token = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
        if not worker_url or not token:
            print("[ERROR] --mode parity requires WORKER_URL and STOCKVISION_AUTH_TOKEN env vars")
            return 1
        passed, failed, errors = run_parity(exit_p, worker_url, token)

    print(f"Passed: {passed}/{len(FIXTURES)}")
    print(f"Failed: {failed}/{len(FIXTURES)}")
    if errors:
        print()
        print("Errors:")
        for e in errors:
            print(e)
        return 1

    print()
    print(f"[OK] All {passed} fixtures passed in {args.mode} mode")
    return 0


if __name__ == "__main__":
    sys.exit(main())
