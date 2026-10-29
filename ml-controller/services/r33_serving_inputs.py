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
    """{symbol: reason} for payloads whose last bar is before run_date, that have none,
    or whose bar dates cannot be read (a fresh bar cannot be shown, and a report never raises)."""
    day = date.fromisoformat(run_date)
    stale = {}
    for payload in payloads:
        symbol = str(payload.get("symbol") or "")
        dates = [str(p["date"])[:10] for p in payload.get("prices") or [] if isinstance(p, dict) and p.get("date")]
        if not dates:
            stale[symbol] = "no_bars"
            continue
        try:
            last = max(date.fromisoformat(d) for d in dates)
        except ValueError:
            stale[symbol] = "bad_bar_date"
            continue
        if last < day:
            stale[symbol] = "last_bar=" + last.isoformat()
    return stale


def staleness_report(stale: dict[str, str], *, payload_count: int, run_date: str, applied: bool) -> dict:
    """C28-16 S3: how many names the stale rule touches; `applied` only under the R33 mode."""
    return {"schema_version": STALENESS_SCHEMA, "run_date": run_date, "payloads": payload_count,
            "stale_count": len(stale), "stale": dict(sorted(stale.items())),
            "effect": "unscored_z0_for_the_day" if applied else "report_only"}


COVERAGE_SCHEMA = "r33-serving-coverage-v1"
COVERAGE_LOG_CRON = "r33-serving-coverage"


def coverage_log(rank_pool: dict, *, row_errors: dict[str, str]) -> tuple[str, str, dict]:
    """(level, message, meta) for the daily ops system_log: per model, how many pool rows
    it left without a score (unscored rows count as missing for every model).

    No threshold: any gap, a model missing for the whole pool, or a Modal row error is a warn."""
    coverage = rank_pool["coverage"]
    total = int(coverage["pool_rows"])
    by_model = {m: {"missing": total - int(n), "total": total} for m, n in coverage["by_model"].items()}
    gaps = sorted(m for m, v in by_model.items() if v["missing"])
    fully_missing = sorted(m for m, v in by_model.items() if v["missing"] == total)
    reasons: dict[str, int] = {}
    for reason in coverage["unscored"].values():
        key = reason.split(":", 1)[0]
        reasons[key] = reasons.get(key, 0) + 1
    meta = {"schema_version": COVERAGE_SCHEMA, "signal_date": rank_pool["signal_date"],
            "screener_run_id": rank_pool["screener_run_id"], "by_model": by_model,
            "models_with_gaps": gaps, "models_fully_missing": fully_missing,
            "uninformative_models": list(rank_pool["uninformative_models"]),
            "pool_rows": total, "pool_scored_rows": int(coverage["pool_scored_rows"]),
            "unscored_by_reason": dict(sorted(reasons.items())), "row_errors": dict(sorted(row_errors.items()))}
    level = "warn" if gaps or row_errors else "info"
    message = (f"R33 coverage {rank_pool['signal_date']}: scored {meta['pool_scored_rows']}/{total}; "
               f"models with gaps {gaps or 'none'}; fully missing {fully_missing or 'none'}; "
               f"Modal row errors {len(row_errors)}")
    return level, message, meta


def write_coverage_log(ops_execute, rank_pool: dict, *, row_errors: dict[str, str], logger) -> dict:
    """Write the day's coverage line to ops system_logs and warn on any gap. A log write
    failure is reported and never fails the run (same contract as Worker writeSystemLog)."""
    import json
    level, message, meta = coverage_log(rank_pool, row_errors=row_errors)
    (logger.warning if level == "warn" else logger.info)("[R33 coverage] %s meta=%s", message,
        {k: meta[k] for k in ("models_with_gaps", "models_fully_missing", "unscored_by_reason")})
    if ops_execute is not None:
        try:
            ops_execute("INSERT INTO system_logs (level, cron_name, message, meta, created_at) "
                        "VALUES (?, ?, ?, ?, datetime('now'))",
                        [level, COVERAGE_LOG_CRON, message, json.dumps(meta, sort_keys=True)])
        except Exception as exc:
            logger.warning("[R33 coverage] system_log write failed: %s: %s", type(exc).__name__, exc)
    return meta
