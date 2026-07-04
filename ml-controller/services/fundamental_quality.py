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


def _number_from(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        number = _number(row.get(key))
        if number is not None:
            return number
    return None


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


def _latest_field_row(
    rows: list[dict[str, Any]],
    field_aliases: dict[str, tuple[str, ...]],
) -> dict[str, Any] | None:
    if not rows:
        return None
    ordered = sorted(
        rows,
        key=lambda row: _sort_key(row, "period", "report_date", "_available_date"),
        reverse=True,
    )
    out: dict[str, Any] = {}
    field_available_dates: dict[str, str | None] = {}
    for canonical_key, aliases in field_aliases.items():
        for row in ordered:
            value = _number_from(row, *aliases)
            if value is None:
                continue
            out[canonical_key] = value
            for alias in aliases:
                out.setdefault(alias, value)
            field_available_dates[canonical_key] = row.get("_available_date")
            break
    if not out:
        return None
    available_dates = [value for value in field_available_dates.values() if value]
    out["_available_date"] = max(available_dates) if available_dates else None
    out["_field_available_dates"] = field_available_dates
    return out


def _score_revenue(
    rows: list[dict[str, Any]],
    growth_row: dict[str, Any] | None = None,
) -> tuple[float, dict[str, Any]]:
    if not rows and not growth_row:
        return 0.0, {"status": "missing"}
    latest: dict[str, Any] = {}
    yoy = mom = avg_yoy = None
    score = 0.0
    if rows:
        ordered = sorted(rows, key=lambda row: _sort_key(row, "revenue_month", "date", "period"))
        latest = ordered[-1]
        recent = ordered[-3:]
        yoy = _number_from(latest, "yoy", "revenue_yoy", "revenue_growth_yoy")
        mom = _number_from(latest, "mom", "revenue_mom")
        yoy_values = [
            n for n in (_number_from(row, "yoy", "revenue_yoy", "revenue_growth_yoy") for row in recent)
            if n is not None
        ]
        avg_yoy = sum(yoy_values) / len(yoy_values) if yoy_values else None
        score = _linear(yoy, 0.0, 30.0, 3.5) + _linear(avg_yoy, 0.0, 25.0, 2.5)
        if mom is not None and mom > 0:
            score += 1.0

    financial_revenue_yoy = _number_from(growth_row or {}, "revenue_growth_yoy")
    operating_income_growth = _number_from(growth_row or {}, "operating_income_growth")
    net_income_growth = _number_from(growth_row or {}, "net_income_growth")
    recurring_income_growth = _number_from(growth_row or {}, "recurring_income_growth")
    if growth_row:
        financial_growth_score = _linear(financial_revenue_yoy, 0.0, 30.0, 3.5)
        if operating_income_growth is not None and operating_income_growth > 0:
            financial_growth_score += 0.5
        if net_income_growth is not None and net_income_growth > 0:
            financial_growth_score += 0.5
        if recurring_income_growth is not None and recurring_income_growth > 0:
            financial_growth_score += 0.3
        score = max(score, financial_growth_score)
    return _clamp(score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["revenueMomentum"]), {
        "latestRevenueMonth": latest.get("revenue_month") or latest.get("date") or latest.get("period"),
        "latestRevenueYoy": yoy,
        "latestRevenueMom": mom,
        "avgRevenueYoy3m": avg_yoy,
        "availableDate": latest.get("_available_date"),
        "financialRevenueGrowthYoy": financial_revenue_yoy,
        "operatingIncomeGrowth": operating_income_growth,
        "netIncomeGrowth": net_income_growth,
        "recurringIncomeGrowth": recurring_income_growth,
    }


def _score_profitability(row: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
    if not row:
        return 0.0, {"status": "missing"}
    roe = _number_from(row, "roe", "roe_comprehensive")
    roe_comprehensive = _number(row.get("roe_comprehensive"))
    roa = _number_from(row, "roa", "roa_comprehensive")
    roa_comprehensive = _number(row.get("roa_comprehensive"))
    eps = _number(row.get("eps"))
    gross_margin = _number_from(row, "gross_margin", "gross_margin_pct")
    operating_margin = _number_from(row, "operating_margin", "operating_margin_pct")
    net_margin = _number(row.get("net_margin"))
    gross_margin_growth = _number(row.get("gross_margin_growth"))
    operating_income_growth = _number(row.get("operating_income_growth"))
    net_income_growth = _number(row.get("net_income_growth"))
    score = _linear(roe, 0.0, 20.0, 1.6)
    score += _linear(roa, 0.0, 10.0, 0.8)
    if eps is not None and eps > 0:
        score += 0.8
    score += _linear(gross_margin, 0.0, 40.0, 0.8)
    score += _linear(operating_margin, 0.0, 20.0, 0.7)
    score += _linear(net_margin, 0.0, 15.0, 0.6)
    growth_tailwind = 0.0
    for value in (gross_margin_growth, operating_income_growth, net_income_growth):
        if value is not None and value > 0:
            growth_tailwind += 0.2
    score += _clamp(growth_tailwind, 0.6)
    return _clamp(score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["profitability"]), {
        "roe": roe,
        "roeComprehensive": roe_comprehensive,
        "roa": roa,
        "roaComprehensive": roa_comprehensive,
        "eps": eps,
        "grossMargin": gross_margin,
        "operatingMargin": operating_margin,
        "netMargin": net_margin,
        "grossMarginGrowth": gross_margin_growth,
        "operatingIncomeGrowth": operating_income_growth,
        "netIncomeGrowth": net_income_growth,
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
    debt_ratio = _number_from(row, "debt_ratio", "liabilities_to_assets")
    liabilities_to_equity = _number(row.get("liabilities_to_equity"))
    equity_to_assets = _number(row.get("equity_to_assets"))
    current_ratio = _number(row.get("current_ratio"))
    quick_ratio = _number(row.get("quick_ratio"))
    operating_cash_flow = _number_from(row, "operating_cash_flow", "cash_flow_from_operations")
    free_cash_flow = _number(row.get("free_cash_flow"))
    cash_flow_ratio = _number(row.get("cash_flow_ratio"))
    interest_expense_ratio = _number(row.get("interest_expense_ratio"))
    leverage_score = 0.0
    if debt_ratio is not None:
        leverage_score = max(leverage_score, _clamp((80.0 - min(max(debt_ratio, 0.0), 80.0)) / 80.0 * 1.2, 1.2))
    leverage_score = max(leverage_score, _linear(equity_to_assets, 40.0, 70.0, 1.2))
    if liabilities_to_equity is not None:
        leverage_score = max(
            leverage_score,
            _clamp((120.0 - min(max(liabilities_to_equity, 0.0), 120.0)) / 120.0 * 1.2, 1.2),
        )
    liquidity_score = _linear(current_ratio, 100.0, 200.0, 0.8) + _linear(quick_ratio, 80.0, 150.0, 0.5)
    cashflow_score = 0.0
    if operating_cash_flow is not None and operating_cash_flow > 0:
        cashflow_score += 0.5
    if free_cash_flow is not None and free_cash_flow > 0:
        cashflow_score += 0.4
    cashflow_score += _linear(cash_flow_ratio, 0.0, 10.0, 0.4)
    interest_score = 0.0
    if interest_expense_ratio is not None:
        interest_score = _clamp((15.0 - min(max(interest_expense_ratio, 0.0), 15.0)) / 15.0 * 0.3, 0.3)
    score = leverage_score + liquidity_score + cashflow_score + interest_score
    return _clamp(score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["financialSafety"]), {
        "debtRatio": debt_ratio,
        "liabilitiesToEquity": liabilities_to_equity,
        "equityToAssets": equity_to_assets,
        "currentRatio": current_ratio,
        "quickRatio": quick_ratio,
        "operatingCashFlowPositive": operating_cash_flow is not None and operating_cash_flow > 0,
        "freeCashFlowPositive": free_cash_flow is not None and free_cash_flow > 0,
        "cashFlowRatio": cash_flow_ratio,
        "interestExpenseRatio": interest_expense_ratio,
    }


def _score_industry(row: dict[str, Any] | None, latest_revenue: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
    percentile = None
    if row:
        percentile = _number_from(row, "industry_percentile", "industry_quality_percentile", "sector_quality_percentile")
    if percentile is None and latest_revenue:
        percentile = _number_from(latest_revenue, "industry_yoy_percentile", "sector_yoy_percentile")
    total_asset_turnover = _number(row.get("total_asset_turnover")) if row else None
    receivables_turnover = _number(row.get("receivables_turnover")) if row else None
    inventory_turnover = _number(row.get("inventory_turnover")) if row else None
    percentile_score = _linear(percentile, 0.5, 1.0, 2.2)
    efficiency_score = (
        _linear(total_asset_turnover, 0.2, 1.0, 0.4)
        + _linear(receivables_turnover, 0.0, 6.0, 0.2)
        + _linear(inventory_turnover, 0.0, 4.0, 0.2)
    )
    return _clamp(percentile_score + efficiency_score, FUNDAMENTAL_QUALITY_BREAKDOWN_MAX["industryRelative"]), {
        "industryPercentile": percentile,
        "totalAssetTurnover": total_asset_turnover,
        "receivablesTurnover": receivables_turnover,
        "inventoryTurnover": inventory_turnover,
    }


def score_fundamental_quality(
    *,
    decision_date: str,
    revenue_rows: list[dict[str, Any]] | None = None,
    financial_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a 0-25 fundamental quality payload with point-in-time guards."""

    decision_date = _iso(decision_date) or decision_date
    revenue_available, dropped_revenue = _available_rows(revenue_rows or [], decision_date, _revenue_available_date)
    financial_available, dropped_financial = _available_rows(financial_rows or [], decision_date, _financial_available_date)
    profitability_row = _latest_field_row(
        financial_available,
        {
            "roe": ("roe",),
            "roe_comprehensive": ("roe_comprehensive",),
            "roa": ("roa",),
            "roa_comprehensive": ("roa_comprehensive",),
            "eps": ("eps",),
            "gross_margin": ("gross_margin", "gross_margin_pct"),
            "operating_margin": ("operating_margin", "operating_margin_pct"),
            "net_margin": ("net_margin",),
            "gross_margin_growth": ("gross_margin_growth",),
            "operating_income_growth": ("operating_income_growth",),
            "net_income_growth": ("net_income_growth",),
        },
    )
    valuation_row = _latest_field_row(
        financial_available,
        {
            "pe": ("pe",),
            "pb": ("pb",),
            "dividend_yield": ("dividend_yield",),
        },
    )
    safety_row = _latest_field_row(
        financial_available,
        {
            "debt_ratio": ("debt_ratio", "liabilities_to_assets"),
            "liabilities_to_equity": ("liabilities_to_equity",),
            "equity_to_assets": ("equity_to_assets",),
            "current_ratio": ("current_ratio",),
            "quick_ratio": ("quick_ratio",),
            "operating_cash_flow": ("operating_cash_flow", "cash_flow_from_operations"),
            "free_cash_flow": ("free_cash_flow",),
            "cash_flow_ratio": ("cash_flow_ratio",),
            "interest_expense_ratio": ("interest_expense_ratio",),
        },
    )
    industry_row = _latest_field_row(
        financial_available,
        {
            "industry_quality_percentile": (
                "industry_percentile",
                "industry_quality_percentile",
                "sector_quality_percentile",
            ),
            "total_asset_turnover": ("total_asset_turnover",),
            "receivables_turnover": ("receivables_turnover",),
            "inventory_turnover": ("inventory_turnover",),
        },
    )
    growth_row = _latest_field_row(
        financial_available,
        {
            "revenue_growth_yoy": ("revenue_growth_yoy",),
            "operating_income_growth": ("operating_income_growth",),
            "net_income_growth": ("net_income_growth",),
            "recurring_income_growth": ("recurring_income_growth",),
        },
    )
    latest_revenue = (
        sorted(revenue_available, key=lambda row: _sort_key(row, "revenue_month", "date", "period"))[-1]
        if revenue_available else None
    )

    revenue_score, revenue_detail = _score_revenue(revenue_available, growth_row)
    profitability_score, profitability_detail = _score_profitability(profitability_row)
    valuation_score, valuation_detail = _score_valuation(valuation_row)
    safety_score, safety_detail = _score_safety(safety_row)
    industry_score, industry_detail = _score_industry(industry_row, latest_revenue)

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
