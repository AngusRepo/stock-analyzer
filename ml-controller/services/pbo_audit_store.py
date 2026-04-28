"""Persist external PBO audits into the existing pbo_results table."""

from __future__ import annotations

import json
from typing import Any

from services.d1_client import execute


def build_pbo_audit_insert(
    *,
    run_date: str,
    source: str,
    audit: dict[str, Any],
) -> tuple[str, list[Any]]:
    raw_details = {
        "origin": source,
        "method": audit.get("method") or "unknown",
        "n_candidates": int(audit.get("n_candidates") or 0),
        "selected_strategy_counts": audit.get("selected_strategy_counts") or {},
        "audit": audit,
    }
    sql = """
        INSERT OR REPLACE INTO pbo_results
        (run_date, source, n_partitions, n_combinations, n_trades,
         pbo, n_oos_negative, oos_mean_return, is_mean_return, degradation,
         go_live_verdict, verdict_reason, raw_details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    params = [
        run_date,
        source,
        int(audit.get("n_partitions") or 0),
        int(audit.get("n_combinations") or 0),
        0,
        float(audit.get("pbo") if audit.get("pbo") is not None else 1.0),
        int(audit.get("n_oos_negative") or 0),
        float(audit.get("oos_mean_return") or 0.0),
        float(audit.get("is_mean_return") or 0.0),
        float(audit.get("degradation") or 0.0),
        str(audit.get("go_live_verdict") or "FAIL"),
        str(audit.get("verdict_reason") or ""),
        json.dumps(raw_details, ensure_ascii=False),
    ]
    return sql, params


def persist_pbo_audit(
    *,
    run_date: str,
    source: str,
    audit: dict[str, Any],
) -> dict[str, Any]:
    sql, params = build_pbo_audit_insert(run_date=run_date, source=source, audit=audit)
    result = execute(sql, params=params)
    return {
        "status": "success",
        "source": source,
        "run_date": run_date,
        "meta": result.get("meta", {}),
    }
