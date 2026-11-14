"""R33 serving inputs: held names in the inference scope, and stale L2 bars (R33-NEW-03, HL2-1#a, C28-16 S3).

Inference scope is the L2 pool plus current holdings: a holding outside the pool still
needs its E-hat for the decay exit. Holdings come from the L4 account read (the same
Worker endpoint prepare_runtime_policy freezes later) and are added for inference only,
never as buy candidates.

A payload whose last bar is older than the run date is stale. Under R33 it is unscored
for the day with that reason (z=0, no E-hat); in any other mode it is only reported.
"""
from __future__ import annotations

import math
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
MODEL_ERROR_SAMPLE = 20   # telemetry only: names whose model_errors / row error text is kept in the line
FEATURE_ROW_ABSENT = "feature_row_absent"


def row_error_code(text: str) -> str:
    """Short attributable code of one Modal feature row error ("Exc: code:detail" or "code:detail").
    A wrapped cause ("code:Exc:inner:...") keeps its inner code: feature_context_failed.r33_prep_row_missing."""
    text = str(text or "").strip() or "unknown_error"
    head, sep, body = text.partition(": ")
    if not (sep and head.isidentifier()):
        head, body = None, text
    code, _, rest = body.partition(":")
    code = code.strip()
    if not code.isidentifier():
        return (head or code)[:80]
    parts = rest.split(":")
    inner = parts[1].strip() if len(parts) > 1 else ""
    if parts[0].strip().isidentifier() and inner.isidentifier() and "_" in inner:  # a snake_case code, not prose
        code += "." + inner
    return code[:80]


def feature_gap_row(payload: dict, error: str | None, feature_models, *, feature_schema: str | None) -> dict:
    """R33 row for a name whose Modal feature row failed or never came back (NEW-1030-06).

    No feature score and no fill: each feature model's gap is named with the row error's
    code (the full text stays on the in-memory row; the coverage line keeps counts and a
    sample), and GNN / sequence scores attach to it like any row. The rank pool unscores the
    name only when no roster model scored it. feature_version is the day's ml-service
    feature schema with zero features used, as ml-service writes it ("<schema>:<n>"); None
    when the day's feature rows do not agree on one schema, and the writer then fails closed."""
    error = str(error) if error else FEATURE_ROW_ABSENT
    code = row_error_code(error)
    prices = payload.get("prices") or []
    last = prices[-1] if prices and isinstance(prices[-1], dict) else {}
    try:
        price = float(last["close"] if last.get("close") is not None else last.get("adj_close"))
    except (TypeError, ValueError):
        price = None
    price = price if price is not None and math.isfinite(price) and price > 0 else None
    return {"stock_id": payload.get("stock_id", 0), "symbol": payload["symbol"], "current_price": price,
            "entry_price": price, "signal": "HOLD", "direction": "neutral", "confidence": 0.0, "models": [],
            "rank_scores": {}, "model_errors": [f"{model}: {code}" for model in feature_models],
            "feature_row_error": error[:500], "features_used": [], "feature_count": 0,
            "feature_version": f"{feature_schema}:0" if feature_schema else None, "production_effect": False}


def _model_error(text: str, models) -> tuple[str, str] | None:
    """(model, reason) for one ml-service model_errors entry of a roster model ("M: reason:..." or
    "reason:M"); None for any other model (one outside the served roster)."""
    for model in models:
        if text.startswith(model + ":"):
            return model, text[len(model) + 1:].strip().split(":", 1)[0][:80]
    for model in models:
        if text.endswith(":" + model):
            return model, text[:-len(model) - 1].split(":", 1)[0][:80]
    return None


def coverage_log(rank_pool: dict, *, row_errors: dict[str, str],
                 model_errors: dict[str, list] | None = None) -> tuple[str, str, dict]:
    """(level, message, meta) for the daily ops system_log: per model, how many pool rows
    it left without a score (unscored rows count as missing for every model), and per model
    the reasons a scored row still lacks it (NEW-1030-06: non-finite input fields or score).

    No threshold: any per-name gap or Modal row error is a warn (that model is z=0 for the
    name). A model with no score on any pool row is an error and aborts the day (Wei 10/30,
    m-d): feature, GNN and sequence models are treated the same."""
    coverage = rank_pool["coverage"]
    models = tuple(coverage["by_model"])  # the served roster: rank_pool coverage is per model_order
    total = int(coverage["pool_rows"])
    by_model = {m: {"missing": total - int(n), "total": total} for m, n in coverage["by_model"].items()}
    gaps = sorted(m for m, v in by_model.items() if v["missing"])
    fully_missing = sorted(m for m, v in by_model.items() if v["missing"] == total)
    reasons: dict[str, int] = {}
    for reason in coverage["unscored"].values():
        key = reason.split(":", 1)[0]
        reasons[key] = reasons.get(key, 0) + 1
    by_reason: dict[str, dict[str, int]] = {}
    per_name: dict[str, str] = {}
    for symbol, errors in sorted((model_errors or {}).items()):
        kept = [str(e) for e in errors or [] if _model_error(str(e), models)]
        for model, reason in (_model_error(e, models) for e in kept):
            by_reason.setdefault(model, {})[reason] = by_reason.get(model, {}).get(reason, 0) + 1
        if kept:
            per_name[symbol] = "; ".join(kept)[:500]
    # Counts cover every name; the per-name text is a sample so a whole-day outage line stays small.
    sample = dict(list(per_name.items())[:MODEL_ERROR_SAMPLE])
    row_reasons: dict[str, int] = {}
    for error in row_errors.values():
        code = row_error_code(error)
        row_reasons[code] = row_reasons.get(code, 0) + 1
    meta = {"schema_version": COVERAGE_SCHEMA, "signal_date": rank_pool["signal_date"],
            "screener_run_id": rank_pool["screener_run_id"], "by_model": by_model,
            "models_with_gaps": gaps, "models_fully_missing": fully_missing,
            "uninformative_models": list(rank_pool["uninformative_models"]),
            "day_aborted": bool(fully_missing), "pool_rows": total, "pool_scored_rows": int(coverage["pool_scored_rows"]),
            "unscored_by_reason": dict(sorted(reasons.items())), "row_errors": {k: str(v)[:500] for k, v in sorted(row_errors.items())[:MODEL_ERROR_SAMPLE]},
            "row_error_names": len(row_errors), "row_errors_by_reason": dict(sorted(row_reasons.items())),
            "model_errors_by_model": {m: dict(sorted(r.items())) for m, r in sorted(by_reason.items())},
            "model_error_names": len(per_name), "model_errors_sample": sample}
    level = "error" if fully_missing else "warn" if gaps or row_errors or per_name else "info"
    message = (("R33 day aborted: models missing for the whole day " + ",".join(fully_missing) + ". ")
               if fully_missing else "") + (f"R33 coverage {rank_pool['signal_date']}: scored {meta['pool_scored_rows']}/{total}; "
               f"models with gaps {gaps or 'none'}; fully missing {fully_missing or 'none'}; "
               f"Modal row errors {len(row_errors)}; model errors on {len(per_name)} names")
    return level, message, meta


def write_coverage_log(ops_execute, rank_pool: dict, *, row_errors: dict[str, str], logger,
                       model_errors: dict[str, list] | None = None) -> dict:
    """Write the day's coverage line to ops system_logs and warn on any gap. A log write
    failure is reported and never fails the run (same contract as Worker writeSystemLog)."""
    import json
    level, message, meta = coverage_log(rank_pool, row_errors=row_errors, model_errors=model_errors)
    {"error": logger.error, "warn": logger.warning}.get(level, logger.info)("[R33 coverage] %s meta=%s", message,
        {k: meta[k] for k in ("models_with_gaps", "models_fully_missing", "unscored_by_reason", "model_errors_by_model")})
    if ops_execute is not None:
        try:
            ops_execute("INSERT INTO system_logs (level, cron_name, message, meta, created_at) "
                        "VALUES (?, ?, ?, ?, datetime('now'))",
                        [level, COVERAGE_LOG_CRON, message, json.dumps(meta, sort_keys=True)])
        except Exception as exc:
            logger.warning("[R33 coverage] system_log write failed: %s: %s", type(exc).__name__, exc)
    return meta


def require_full_day_coverage(meta: dict) -> None:
    """Abort the day when any roster model scored no pool row (after the ops line)."""
    if meta["models_fully_missing"]:
        raise RuntimeError("r33_model_missing_for_day:" + ",".join(meta["models_fully_missing"]))
