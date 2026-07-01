"""Score V2 fundamental-quality scorer.

The scorer is intentionally pure: callers pass point-in-time candidate rows and
this module filters by conservative availability dates before scoring. It does
not query D1 or FinLab directly.
"""

from __future__ import annotations

import math
import re
from datetime import date, timedelta
from typing import Any

from services.training_calendar import monthly_revenue_available_date


FUNDAMENTAL_QUALITY_MAX = 25.0
FUNDAMENTAL_QUALITY_BREAKDOWN_MAX = {
    "revenueMomentum": 7.0,
    "profitability": 6.0,
    "valuation": 5.0,
    "financialSafety": 4.0,
    "industryRelative": 3.0,
}


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _round1(value: float) -> float:
    return math.floor(float(value) * 10 + 0.5) / 10


def _clamp(value: Any, maximum: float) -> float:
    number = _number(value)
    if number is None:
        return 0.0
    return _round1(max(0.0, min(float(maximum), number)))


def _linear(value: Any, lower: float, upper: float, maximum: float) -> float:
    number = _number(value)
    if number is None:
        return 0.0
    if upper <= lower:
        return 0.0
    return _clamp(((number - lower) / (upper - lower)) * maximum, maximum)


def _iso(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        return None


def _period_quarter_available_date(period: Any, lag_days: int = 60) -> str | None:
    text = str(period or "").strip()
    match = re.match(r"^(\d{4})[-/]?Q([1-4])$", text, flags=re.IGNORECASE)
    if not match:
        return None
    year = int(match.group(1))
    quarter = int(match.group(2))
    end_month = quarter * 3
    next_month = end_month + 1
    next_year = year
    if next_month == 13:
        next_month = 1
        next_year += 1
    quarter_end = date(next_year, next_month, 1) - timedelta(days=1)
    return (quarter_end + timedelta(days=lag_days)).isoformat()


def _revenue_available_date(row: dict[str, Any]) -> str | None:
    explicit = _iso(row.get("available_date") or row.get("published_at") or row.get("announcement_date"))
    if explicit:
        return explicit
    period = row.get("revenue_month") or row.get("date") or row.get("period")
    if period:
        try:
            return monthly_revenue_available_date(str(period))
        except ValueError:
            return None
    return _iso(row.get("as_of_date"))


def _financial_available_date(row: dict[str, Any]) -> str | None:
    explicit = _iso(row.get("available_date") or row.get("published_at") or row.get("report_date"))
    if explicit:
        return explicit
    period_available = _period_quarter_available_date(row.get("period"))
    if period_available:
        return period_available
    return _iso(row.get("as_of_date"))


def _available_rows(rows: list[dict[str, Any]], decision_date: str, date_fn) -> tuple[list[dict[str, Any]], int]:
    available: list[dict[str, Any]] = []
    dropped = 0
    for row in rows:
        available_date = date_fn(row)
        if available_date is None or available_date > decision_date:
            dropped += 1
            continue
        available.append({**row, "_available_date": available_date})
    return available, dropped


def _sort_key(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value:
            return str(value)
    return ""


def _score_revenue(rows: list[dict[str, Any]]) -> tuple[float, dict[str, Any]]:
    if not rows:
        return 0.0, {"status": "missing"}
    ordered = sorted(rows, key=lambda row: _sort_key(row, "revenue_month", "date", "period"))
    latest = ordered[-1]
    recent = ordered[-3:]
    yoy = _number(latest.get("yoy") or latest.get("revenue_yoy") or latest.get("revenue_growth_yoy"))
    mom = _number(latest.get("mom") or latest.get("revenue_mom"))
    yoy_values = [
        n for n in (_number(row.get("yoy") or row.get("revenue_yoy") or row.get("revenue_growth_yoy")) for row in recent)
        if n is not None
    ]
    avg_yoy = sum(yoy_values) / len(yoy_values) if yoy_values else None
    score = _linear(yoy, 0.0, 30.0, 3.5) + _linear(avg_yoy, 0.0, 25.0, 2.5)
    if mom is not None and mom > 0:
        score += 1.0
    return _clamp(score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["revenueMomentum"]), {
        "latestRevenueMonth": latest.get("revenue_month") or latest.get("date") or latest.get("period"),
        "latestRevenueYoy": yoy,
        "latestRevenueMom": mom,
        "avgRevenueYoy3m": avg_yoy,
        "availableDate": latest.get("_available_date"),
    }


def _score_profitability(row: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
    if not row:
        return 0.0, {"status": "missing"}
    roe = _number(row.get("roe"))
    eps = _number(row.get("eps"))
    gross_margin = _number(row.get("gross_margin") or row.get("gross_margin_pct"))
    operating_margin = _number(row.get("operating_margin") or row.get("operating_margin_pct"))
    score = _linear(roe, 0.0, 20.0, 2.8)
    if eps is not None and eps > 0:
        score += 1.2
    score += _linear(gross_margin, 0.0, 40.0, 1.2)
    score += _linear(operating_margin, 0.0, 20.0, 0.8)
    return _clamp(score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["profitability"]), {
        "roe": roe,
        "eps": eps,
        "grossMargin": gross_margin,
        "operatingMargin": operating_margin,
        "availableDate": row.get("_available_date"),
    }


def _score_valuation(row: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
    if not row:
        return 0.0, {"status": "missing"}
    pe = _number(row.get("pe"))
    pb = _number(row.get("pb"))
    dividend_yield = _number(row.get("dividend_yield"))
    score = 0.0
    if pe is not None and pe > 0:
        score += _clamp((30.0 - min(pe, 30.0)) / 30.0 * 1.8, 1.8)
    if pb is not None and pb > 0:
        score += _clamp((4.0 - min(pb, 4.0)) / 4.0 * 1.2, 1.2)
    score += _linear(dividend_yield, 0.0, 5.0, 2.0)
    return _clamp(score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["valuation"]), {
        "pe": pe,
        "pb": pb,
        "dividendYield": dividend_yield,
    }


def _score_safety(row: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
    if not row:
        return 0.0, {"status": "missing"}
    debt_ratio = _number(row.get("debt_ratio") or row.get("liabilities_to_assets"))
    current_ratio = _number(row.get("current_ratio"))
    operating_cash_flow = _number(row.get("operating_cash_flow") or row.get("cash_flow_from_operations"))
    score = 0.0
    if debt_ratio is not None:
        score += _clamp((80.0 - min(max(debt_ratio, 0.0), 80.0)) / 80.0 * 1.6, 1.6)
    score += _linear(current_ratio, 100.0, 200.0, 1.4)
    if operating_cash_flow is not None and operating_cash_flow > 0:
        score += 1.0
    return _clamp(score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["financialSafety"]), {
        "debtRatio": debt_ratio,
        "currentRatio": current_ratio,
        "operatingCashFlowPositive": operating_cash_flow is not None and operating_cash_flow > 0,
    }


def _score_industry(row: dict[str, Any] | None, latest_revenue: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
    percentile = None
    if row:
        percentile = _number(
            row.get("industry_percentile")
            or row.get("industry_quality_percentile")
            or row.get("sector_quality_percentile")
        )
    if percentile is None and latest_revenue:
        percentile = _number(latest_revenue.get("industry_yoy_percentile") or latest_revenue.get("sector_yoy_percentile"))
    score = _linear(percentile, 0.5, 1.0, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["industryRelative"])
    return score, {"industryPercentile": percentile}


def score_fundamental_quality(
    *,
    decision_date: str,
    revenue_rows: list[dict[str, Any]] | None = None,
    financial_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a 0-20 fundamental quality payload with point-in-time guards."""

    decision_date = _iso(decision_date) or decision_date
    revenue_available, dropped_revenue = _available_rows(revenue_rows or [], decision_date, _revenue_available_date)
    financial_available, dropped_financial = _available_rows(financial_rows or [], decision_date, _financial_available_date)
    financial_latest = (
        sorted(financial_available, key=lambda row: _sort_key(row, "period", "report_date", "_available_date"))[-1]
        if financial_available else None
    )
    latest_revenue = (
        sorted(revenue_available, key=lambda row: _sort_key(row, "revenue_month", "date", "period"))[-1]
        if revenue_available else None
    )

    revenue_score, revenue_detail = _score_revenue(revenue_available)
    profitability_score, profitability_detail = _score_profitability(financial_latest)
    valuation_score, valuation_detail = _score_valuation(financial_latest)
    safety_score, safety_detail = _score_safety(financial_latest)
    industry_score, industry_detail = _score_industry(financial_latest, latest_revenue)

    components = {
        "revenueMomentum": revenue_score,
        "profitability": profitability_score,
        "valuation": valuation_score,
        "financialSafety": safety_score,
        "industryRelative": industry_score,
    }
    data_issues: list[str] = []
    if not revenue_available:
        data_issues.append("missing_revenue_rows")
    if not financial_available:
        data_issues.append("missing_financial_rows")
    if dropped_revenue:
        data_issues.append("future_revenue_rows_dropped")
    if dropped_financial:
        data_issues.append("future_financial_rows_dropped")

    return {
        "version": "fundamental_quality_v1",
        "score": _clamp(sum(components.values()), FUNDAMENTAL_QUALITY_MAX),
        "maxScore": FUNDAMENTAL_QUALITY_MAX,
        "components": components,
        "componentMax": FUNDAMENTAL_QUALITY_BREAKDOWN_MAX,
        "details": {
            "revenueMomentum": revenue_detail,
            "profitability": profitability_detail,
            "valuation": valuation_detail,
            "financialSafety": safety_detail,
            "industryRelative": industry_detail,
        },
        "dataIssues": data_issues,
        "noLookahead": {
            "decisionDate": decision_date,
            "droppedFutureRevenueRows": dropped_revenue,
            "droppedFutureFinancialRows": dropped_financial,
        },
    }
