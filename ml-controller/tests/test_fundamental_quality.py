from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.fundamental_quality import score_fundamental_quality  # noqa: E402


def test_fundamental_quality_uses_latest_non_null_fields_per_component() -> None:
    payload = score_fundamental_quality(
        decision_date="2026-07-02",
        revenue_rows=[
            {"revenue_month": "2026-04-10", "yoy": 61.83, "mom": 37.16, "as_of_date": "2026-05-18"},
            {"revenue_month": "2026-05-11", "yoy": 35.25, "mom": 6.75, "as_of_date": "2026-05-18"},
            {"revenue_month": "2026-06-10", "yoy": 82.23, "mom": 10.11, "as_of_date": "2026-06-16"},
        ],
        financial_rows=[
            {
                "period": "2026-06-29",
                "report_date": "2026-06-29",
                "available_date": "2026-06-29",
                "pe": 37.57,
                "pb": 3.8,
                "dividend_yield": 1.6,
            },
            {
                "period": "2026-01-01",
                "report_date": "2026-01-01",
                "available_date": "2026-06-29",
                "revenue_growth_yoy": 38.0127,
                "gross_margin": 40.5874,
                "operating_margin": 21.8364,
                "roe": 3.5521,
                "roe_comprehensive": 4.0626,
                "roa": 2.5858,
                "roa_comprehensive": 2.8817,
                "eps": 2.4488,
                "debt_ratio": 30.9986,
                "current_ratio": 193.7960,
                "operating_cash_flow": 74158,
                "free_cash_flow": 19882,
                "net_margin": 20.0815,
                "quick_ratio": 144.3507,
                "cash_flow_ratio": 4.7695,
                "equity_to_assets": 69.0014,
                "liabilities_to_equity": 44.9245,
                "gross_margin_growth": 73.3880,
                "operating_income_growth": 120.8948,
                "net_income_growth": 108.3891,
                "recurring_income_growth": 108.3891,
                "total_asset_turnover": 0.1255,
                "receivables_turnover": 1.5648,
                "inventory_turnover": 0.6778,
                "interest_expense_ratio": 3.1996,
            },
        ],
    )

    assert payload["components"]["revenueMomentum"] == pytest.approx(7.0)
    assert payload["components"]["valuation"] == pytest.approx(0.7)
    assert payload["components"]["profitability"] >= 4.0
    assert payload["components"]["financialSafety"] > 3.0
    assert payload["score"] >= 15.0
    assert payload["details"]["profitability"]["roe"] == pytest.approx(3.5521)
    assert payload["details"]["profitability"]["roa"] == pytest.approx(2.5858)
    assert payload["details"]["profitability"]["netMargin"] == pytest.approx(20.0815)
    assert payload["details"]["valuation"]["pe"] == pytest.approx(37.57)
    assert payload["details"]["financialSafety"]["quickRatio"] == pytest.approx(144.3507)
    assert payload["details"]["financialSafety"]["freeCashFlowPositive"] is True
    assert payload["dataIssues"] == []


def test_recommendation_loader_selects_expanded_fundamental_inputs() -> None:
    source = (Path(__file__).resolve().parent.parent / "services" / "recommendation_service.py").read_text(encoding="utf-8")
    for column in [
        "roa",
        "roa_comprehensive",
        "roe_comprehensive",
        "free_cash_flow",
        "net_margin",
        "quick_ratio",
        "cash_flow_ratio",
        "equity_to_assets",
        "liabilities_to_equity",
        "gross_margin_growth",
        "operating_income_growth",
        "net_income_growth",
        "recurring_income_growth",
        "total_asset_turnover",
        "receivables_turnover",
        "inventory_turnover",
        "interest_expense_ratio",
    ]:
        assert column in source
