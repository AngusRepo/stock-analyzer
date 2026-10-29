"""R33 serving inputs: held names in the inference scope, and stale L2 bars (R33-NEW-03, HL2-1#a, C28-16 S3).

Inference scope is the L2 pool plus current holdings: a holding outside the pool still
needs its E-hat for the decay exit. Holdings come from the L4 account read (the same
Worker endpoint prepare_runtime_policy freezes later) and are added for inference only,
never as buy candidates.

A payload whose last bar is older than the run date is stale. Under R33 it is unscored
for the day with that reason (z=0, no E-hat); in any other mode it is only reported.
"""
from __future__ import annotations

from datetime import date

STALENESS_SCHEMA = "l2-input-staleness-report-v1"


def holding_stocks(*, signal_date: str, active_stocks: list[dict], account_reader, core_query) -> tuple[list[dict], list[str]]:
    """(stocks to add to the ML universe, every held symbol) from the L4 account read."""
    from services.payload_builder import build_ml_universe
    account = account_reader(signal_date)
    holdings = account.get("holdings") if isinstance(account, dict) else None
    if not isinstance(holdings, list) or account.get("signal_date") != signal_date:
        raise ValueError("r33_holdings_unavailable")
    held = sorted({str(h["symbol"]) for h in holdings})
    present = {str(s.get("symbol")) for s in active_stocks}
    missing = [s for s in held if s not in present]
    added = []
    for offset in range(0, len(missing), 80):
        chunk = missing[offset:offset + 80]
        rows = core_query("SELECT id,symbol,name,market FROM stocks WHERE symbol IN ("
                          + ",".join("?" for _ in chunk) + ")", chunk)
        for row in rows:
            if (row.get("symbol") not in chunk or type(row.get("id")) is not int or row["id"] <= 0
                    or not isinstance(row.get("market"), str) or not row["market"].strip()):
                raise ValueError("r33_holding_stock_identity_invalid")
            added.extend(build_ml_universe([{**row, "eligible_for_pending_buy": False}], []))
    if sorted(s["symbol"] for s in added) != missing:
        raise ValueError("r33_holding_stock_identity_missing")
    return added, held


def stale_inputs(payloads: list[dict], run_date: str) -> dict[str, str]:
    """{symbol: reason} for payloads whose last bar is before run_date (or that have none)."""
    day = date.fromisoformat(run_date)
    stale = {}
    for payload in payloads:
        symbol = str(payload.get("symbol") or "")
        dates = [str(p["date"])[:10] for p in payload.get("prices") or [] if isinstance(p, dict) and p.get("date")]
        if not dates:
            stale[symbol] = "no_bars"
        elif date.fromisoformat(max(dates)) < day:
            stale[symbol] = "last_bar=" + max(dates)
    return stale


def staleness_report(stale: dict[str, str], *, payload_count: int, run_date: str, applied: bool) -> dict:
    """C28-16 S3: how many names the stale rule touches; `applied` only under the R33 mode."""
    return {"schema_version": STALENESS_SCHEMA, "run_date": run_date, "payloads": payload_count,
            "stale_count": len(stale), "stale": dict(sorted(stale.items())),
            "effect": "unscored_z0_for_the_day" if applied else "report_only"}
