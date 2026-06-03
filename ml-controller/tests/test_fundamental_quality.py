from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import recommendation_service  # noqa: E402
from services.fundamental_quality import score_fundamental_quality  # noqa: E402
from services.recommendation_service import (  # noqa: E402
    build_score_components,
    filter_and_score_recommendations,
    load_fundamental_quality_by_symbol,
)


def _score_components_base() -> dict:
    return {
        "version": "score_v2",
        "components": {
            "mlEdge": 0,
            "chipFlow": 10,
            "technicalStructure": 10,
            "fundamentalQuality": 0,
            "newsTheme": 0,
        },
        "total": 20,
        "finalScore": 20,
    }


def test_fundamental_quality_drops_monthly_revenue_before_conservative_available_date():
    result = score_fundamental_quality(
        decision_date="2026-05-10",
        revenue_rows=[
            {"revenue_month": "2026-03", "yoy": 12, "mom": 1},
            {"revenue_month": "2026-04", "yoy": 60, "mom": 10},
        ],
    )

    assert result["details"]["revenueMomentum"]["latestRevenueMonth"] == "2026-03"
    assert result["noLookahead"]["droppedFutureRevenueRows"] == 1
    assert "future_revenue_rows_dropped" in result["dataIssues"]


def test_fundamental_quality_uses_monthly_revenue_after_available_date():
    result = score_fundamental_quality(
        decision_date="2026-05-13",
        revenue_rows=[
            {"revenue_month": "2026-03", "yoy": 12, "mom": 1},
            {"revenue_month": "2026-04", "yoy": 60, "mom": 10},
        ],
    )

    assert result["details"]["revenueMomentum"]["latestRevenueMonth"] == "2026-04"
    assert result["components"]["revenueMomentum"] == pytest.approx(6.0)
    assert result["score"] <= 20


def test_fundamental_quality_drops_quarterly_financials_until_available_lag():
    result = score_fundamental_quality(
        decision_date="2026-05-20",
        revenue_rows=[{"revenue_month": "2026-03", "yoy": 10, "mom": 1}],
        financial_rows=[{"period": "2026Q1", "roe": 25, "eps": 2.1, "pe": 12, "pb": 1.5}],
    )

    assert result["components"]["profitability"] == 0
    assert result["noLookahead"]["droppedFutureFinancialRows"] == 1
    assert "missing_financial_rows" in result["dataIssues"]


def test_fundamental_quality_scores_available_financial_and_industry_rows():
    result = score_fundamental_quality(
        decision_date="2026-06-05",
        revenue_rows=[{"revenue_month": "2026-04", "yoy": 25, "mom": 3, "industry_yoy_percentile": 0.8}],
        financial_rows=[{
            "period": "2026Q1",
            "roe": 18,
            "eps": 2.1,
            "pe": 12,
            "pb": 1.4,
            "dividend_yield": 3,
            "debt_ratio": 35,
            "current_ratio": 180,
            "operating_cash_flow": 100,
            "industry_quality_percentile": 0.9,
        }],
    )

    assert result["components"]["profitability"] > 0
    assert result["components"]["valuation"] > 0
    assert result["components"]["financialSafety"] > 0
    assert result["components"]["industryRelative"] > 0
    assert result["score"] <= 20


def test_score_v2_builder_accepts_fundamental_quality_score_without_legacy_projection():
    payload = build_score_components(
        {
            "score_components": _score_components_base(),
            "score_seed_inputs": {
                "chipFlowSeed40": 16,
                "technicalSeed30": 12,
                "screenerMomentumSeed20": 4,
                "mlEdgeSeed30": 18,
                "personaAlphaSeed": 0,
            },
            "fundamental_quality": {"score": 14.2, "version": "fundamental_quality_v1"},
        },
        raw_score=50,
    )

    assert payload["components"]["fundamentalQuality"] == pytest.approx(14.2)
    assert payload["fundamentalQuality"]["version"] == "fundamental_quality_v1"
    assert "legacyComponents" not in payload


def test_load_fundamental_quality_by_symbol_reads_d1_inputs_fail_soft(monkeypatch):
    def fake_query(sql, params, timeout=60):
        if "canonical_revenue_monthly" in sql:
            return [
                {"stock_id": "2330", "revenue_month": "2026-04", "yoy": 25, "mom": 3, "as_of_date": "2026-05-01"},
            ]
        if "canonical_fundamental_features" in sql:
            assert params == ["2330", "2026-06-05"]
            assert "source = 'finlab.fundamental_factor_diversity'" in sql
            return [
                {
                    "stock_id": "2330",
                    "period": "2026-03-31",
                    "available_date": "2026-05-30",
                    "roe": 18,
                    "eps": 2,
                    "pe": 12,
                    "pb": 1.4,
                    "dividend_yield": 3,
                    "debt_ratio": 35,
                    "current_ratio": 180,
                    "operating_cash_flow": 100,
                    "industry_quality_percentile": 0.9,
                },
            ]
        if "FROM financials" in sql:
            raise AssertionError("legacy financials fallback must not be queried")
        raise AssertionError(sql)

    monkeypatch.setattr(recommendation_service.d1_client, "query", fake_query)

    result = load_fundamental_quality_by_symbol(
        [{"symbol": "2330", "stock_id": 1}],
        "2026-06-05",
    )

    assert result["2330"]["version"] == "fundamental_quality_v1"
    assert result["2330"]["score"] > 0
    assert result["2330"]["details"]["profitability"]["roe"] == 18.0


def test_filter_and_score_recommendations_attaches_fundamental_quality(monkeypatch):
    monkeypatch.setattr(recommendation_service, "_is_use_ensemble_v2", lambda: True)
    score_components = _score_components_base()
    score_components["seedComponents"] = {
        "chipFlowSeed40": 16,
        "technicalSeed30": 12,
        "screenerMomentumSeed20": 4,
        "mlEdgeSeed30": 0,
        "personaAlphaSeed": 0,
    }
    final, _ = filter_and_score_recommendations(
        [{
            "id": 1,
            "stock_id": 1,
            "date": "2026-06-05",
            "symbol": "2330",
            "name": "TSMC",
            "sector": "Semis",
            "industry": "IC",
            "market_segment": "LISTED",
            "recommendation_lane": "tradable",
            "eligible_for_pending_buy": 1,
            "score_components": score_components,
        }],
        {"2330": {
            "signal": "HOLD",
            "confidence": 0.4,
            "forecast_pct": 0.01,
            "ensemble_v2": {"signal": "BUY", "confidence": 0.75, "forecast_pct": 0.03, "signal_source": "ensemble_v2"},
            "models": {"m": {"direction": "up"}},
        }},
        [{"symbol": "2330", "prices": [{"date": "2026-06-05", "close": 100}], "indicators": [], "chips": []}],
        fundamental_quality_by_symbol={"2330": {"version": "fundamental_quality_v1", "score": 13.5}},
    )

    assert final[0]["score_components"]["components"]["fundamentalQuality"] == pytest.approx(13.5)
    assert final[0]["score_components"]["fundamentalQuality"]["version"] == "fundamental_quality_v1"
