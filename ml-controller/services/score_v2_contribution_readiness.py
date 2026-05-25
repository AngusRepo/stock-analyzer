"""Read-only Score V2 contribution readiness diagnostics."""

from __future__ import annotations

import math
from typing import Any


SCORE_V2_CONTRIBUTION_READINESS_SCHEMA = "score-v2-contribution-readiness-v1"


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _int(value: Any) -> int:
    number = _number(value)
    return int(number) if number is not None else 0


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _latest_by_date(rows: list[dict[str, Any]]) -> dict[str, Any]:
    dated = [row for row in rows if str(row.get("date") or "").strip()]
    if not dated:
        return {}
    return max(dated, key=lambda row: str(row.get("date") or ""))


def _sum_rows(rows: list[dict[str, Any]], key: str) -> int:
    return sum(_int(row.get(key)) for row in rows)


def _check(checks: list[dict[str, Any]], check_id: str, passed: bool, value: Any, expected: Any) -> None:
    checks.append({
        "id": check_id,
        "passed": bool(passed),
        "value": value,
        "expected": expected,
    })


def build_score_v2_contribution_readiness_report(
    *,
    table_names: list[str],
    inventory: dict[str, Any],
    daily_component_rows: list[dict[str, Any]],
    theme_signal_rows: list[dict[str, Any]] | None = None,
    funnel_stage_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Evaluate whether fundamental/news Score V2 contributions can cut over."""

    tables = {str(name).strip() for name in table_names if str(name).strip()}
    theme_signal_rows = theme_signal_rows or []
    funnel_stage_rows = funnel_stage_rows or []
    latest_daily = _latest_by_date(daily_component_rows)
    checks: list[dict[str, Any]] = []
    root_causes: list[str] = []

    fundamental_table_exists = "canonical_fundamental_features" in tables
    revenue_total = _int(inventory.get("revenue_total"))
    financials_total = _int(inventory.get("financials_total"))
    fundamental_total = _int(inventory.get("fundamental_total"))
    latest_fundamental_nonzero = _int(latest_daily.get("fundamental_nonzero"))
    latest_daily_n = _int(latest_daily.get("n"))
    latest_date = str(latest_daily.get("date") or "")

    _check(
        checks,
        "canonical_fundamental_features_table",
        fundamental_table_exists,
        fundamental_table_exists,
        True,
    )
    _check(
        checks,
        "fundamental_source_inputs",
        revenue_total > 0 or financials_total > 0 or fundamental_total > 0,
        {
            "canonical_revenue_monthly": revenue_total,
            "financials": financials_total,
            "canonical_fundamental_features": fundamental_total,
        },
        "> 0 source rows",
    )
    _check(
        checks,
        "latest_daily_fundamental_nonzero",
        latest_daily_n > 0 and latest_fundamental_nonzero > 0,
        {"date": latest_date, "rows": latest_daily_n, "fundamental_nonzero": latest_fundamental_nonzero},
        "> 0 latest daily recommendations with fundamentalQuality > 0",
    )
    if not fundamental_table_exists:
        root_causes.append("canonical_fundamental_features_missing")
    elif fundamental_total == 0:
        root_causes.append("canonical_fundamental_features_empty")
    if latest_daily_n > 0 and latest_fundamental_nonzero == 0:
        root_causes.append("fundamental_quality_live_zero")

    theme_total = _int(inventory.get("theme_total"))
    stock_theme_total = _int(inventory.get("stock_theme_total"))
    evidence_total = _int(inventory.get("evidence_total"))
    news_7d_total = _int(inventory.get("news_7d_total"))
    latest_news_nonzero = _int(latest_daily.get("news_nonzero"))
    buzz_evidence_rows = _sum_rows(
        [row for row in funnel_stage_rows if str(row.get("stage")) == "buzz_evidence"],
        "n",
    )
    theme_sources = {
        str(row.get("source") or "unknown"): _int(row.get("n"))
        for row in theme_signal_rows
        if row.get("source") is not None
    }
    news_inputs_available = any(value > 0 for value in [
        theme_total,
        stock_theme_total,
        evidence_total,
        news_7d_total,
        buzz_evidence_rows,
    ])

    _check(
        checks,
        "news_theme_inputs",
        news_inputs_available,
        {
            "theme_signals": theme_total,
            "stock_theme_features": stock_theme_total,
            "external_evidence_items": evidence_total,
            "news_7d": news_7d_total,
            "buzz_evidence_rows": buzz_evidence_rows,
        },
        "> 0 news/theme input rows",
    )
    _check(
        checks,
        "latest_daily_news_nonzero",
        latest_daily_n > 0 and latest_news_nonzero > 0,
        {"date": latest_date, "rows": latest_daily_n, "news_nonzero": latest_news_nonzero},
        "> 0 latest daily recommendations with newsTheme > 0",
    )
    if news_inputs_available and buzz_evidence_rows > 0 and latest_news_nonzero == 0:
        root_causes.append("news_theme_handoff_missing")
    elif latest_daily_n > 0 and latest_news_nonzero == 0:
        root_causes.append("news_theme_live_zero")

    failed_checks = [check["id"] for check in checks if not check["passed"]]
    decision = "PASS" if not failed_checks and not root_causes else "BLOCK"
    return {
        "schema_version": SCORE_V2_CONTRIBUTION_READINESS_SCHEMA,
        "mode": "read_only",
        "decision": decision,
        "passed": decision == "PASS",
        "failed_checks": failed_checks,
        "root_causes": list(dict.fromkeys(root_causes)),
        "checks": checks,
        "latest_daily_date": latest_date or None,
        "latest_daily_rows": latest_daily_n,
        "component_nonzero": {
            "fundamentalQuality": latest_fundamental_nonzero,
            "newsTheme": latest_news_nonzero,
        },
        "input_summary": {
            "tables": sorted(tables),
            "revenue_latest_month": inventory.get("revenue_latest_month"),
            "financials_latest_period": inventory.get("financials_latest_period"),
            "theme_latest_date": inventory.get("theme_latest_date"),
            "stock_theme_latest_date": inventory.get("stock_theme_latest_date"),
            "evidence_latest_published_at": inventory.get("evidence_latest_published_at"),
            "theme_sources_recent": theme_sources,
            "buzz_evidence_rows": buzz_evidence_rows,
        },
        "readiness_ratio": {
            "fundamentalQuality": _round(latest_fundamental_nonzero / latest_daily_n, 4) if latest_daily_n else 0.0,
            "newsTheme": _round(latest_news_nonzero / latest_daily_n, 4) if latest_daily_n else 0.0,
        },
        "allowed_next_action": "owner_switch_candidate" if decision == "PASS" else "repair_inputs_or_handoff",
    }
