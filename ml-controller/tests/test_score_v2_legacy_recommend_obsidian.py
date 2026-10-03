from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import recommend as recommend_router  # noqa: E402
from services.obsidian_writer import _render  # noqa: E402
from services.recommend_score_v2_projection import build_score_v2_route_candidate, rank_score_v2_route_candidates  # noqa: E402


def _score_v2_payload(final_score: float = 88.0) -> str:
    return json.dumps(
        {
            "version": "score_v2",
            "weights": {
                "mlEdge": 25,
                "chipFlow": 25,
                "technicalStructure": 25,
                "fundamentalQuality": 25,
                "newsTheme": 0,
            },
            "components": {
                "mlEdge": 22,
                "chipFlow": 21,
                "technicalStructure": 20,
                "fundamentalQuality": 18,
                "newsTheme": 4,
            },
            "total": 85,
            "alphaAdjustment": final_score - 85,
            "finalScore": final_score,
        }
    )


def _score_seed_inputs(*, high: bool = True) -> dict[str, float]:
    if high:
        return {
            "chipFlowSeed40": 32.0,
            "technicalSeed30": 24.0,
            "screenerMomentumSeed20": 16.0,
            "mlEdgeSeed30": 27.0,
            "personaAlphaSeed": 0.0,
        }
    return {
        "chipFlowSeed40": 0.0,
        "technicalSeed30": 10.0,
        "screenerMomentumSeed20": 0.0,
        "mlEdgeSeed30": 18.0,
        "personaAlphaSeed": 0.0,
    }


def test_legacy_recommend_route_returns_score_v2_payload(monkeypatch: pytest.MonkeyPatch):
    import httpx
    def reject_network(*args, **kwargs):
        raise AssertionError("recommend route must not call an LLM provider")
    monkeypatch.setattr(httpx, "post", reject_network)

    req = recommend_router.RecommendRequest(
        date="2026-05-21",
        top_n=1,
        stocks=[
            {
                "stock_id": 1,
                "symbol": "2330",
                "name": "TSMC",
                "sector": "Semiconductor",
                "current_price": 900,
                "foreign_net_5d": 2_000_000_000,
                "trust_net_5d": 200_000_000,
                "foreign_consecutive": 5,
                "rsi14": 60,
                "macd_hist": 2.5,
                "ma5": 880,
                "ma20": 850,
                "ma60": 800,
                "momentum_score": 20,
                "ml_signal": "STRONG_BUY",
                "ml_confidence": 0.9,
                "hist_accuracy": 0.62,
                "hist_count": 30,
                "score_seed_inputs": _score_seed_inputs(),
            }
        ],
    )

    result = recommend_router.post_recommend(req)

    rec = result["recommendations"][0]
    assert rec["reason"] == "Score V2 context available; LLM reason not generated."
    assert rec["score_components"]["version"] == "score_v2"
    assert rec["score_components"]["weights"]["mlEdge"] == 25
    assert rec["score"] == pytest.approx(rec["score_components"]["finalScore"])
    assert rec["score"] < rec["score_components"]["rawScore"]


def test_recommend_route_projection_ranks_by_score_v2_final_score():
    ranked = rank_score_v2_route_candidates(
        [
            {
                "stock_id": 1,
                "symbol": "LOW",
                "name": "Low",
                "current_price": 100,
                "foreign_net_5d": 0,
                "trust_net_5d": 0,
                "foreign_consecutive": 0,
                "rsi14": 60,
                "macd_hist": 1,
                "ma5": 90,
                "ma20": 90,
                "ma60": 90,
                "momentum_score": 0,
                "ml_signal": "BUY",
                "ml_confidence": 0.8,
                "hist_count": 0,
                "score_seed_inputs": _score_seed_inputs(high=False),
            },
            {
                "stock_id": 2,
                "symbol": "HIGH",
                "name": "High",
                "current_price": 100,
                "foreign_net_5d": 2_000_000_000,
                "trust_net_5d": 500_000_000,
                "foreign_consecutive": 5,
                "rsi14": 60,
                "macd_hist": 1,
                "ma5": 90,
                "ma20": 90,
                "ma60": 90,
                "momentum_score": 20,
                "ml_signal": "STRONG_BUY",
                "ml_confidence": 0.9,
                "hist_accuracy": 0.62,
                "hist_count": 30,
                "score_seed_inputs": _score_seed_inputs(),
            },
        ],
        min_final_score=0,
    )

    assert ranked[0].symbol == "HIGH"
    assert ranked[0].final_score == pytest.approx(ranked[0].score_components["finalScore"])
    assert ranked[0].score_components["version"] == "score_v2"


def test_obsidian_pipeline_template_renders_score_v2_final_score():
    content = _render(
        "pipeline.md.j2",
        date="2026-05-21",
        recommendations=[
            {
                "symbol": "2330",
                "name": "TSMC",
                "sector": "Semiconductor",
                "signal": "BUY",
                "confidence": 0.82,
                "score": 10,
                "chip_score": 1,
                "tech_score": 1,
                "ml_score": 1,
                "score_components": _score_v2_payload(88),
            }
        ],
        t2_buys=[],
    )

    assert "Score V2" in content
    assert "| 1 | 2330 | TSMC | 88" in content
    assert "ML Edge 22.0/25" in content
    assert "score_v2" in content
    assert "Chip(0-40)" not in content
    assert "Score **10" not in content


def test_obsidian_trade_template_renders_score_v2_breakdown():
    content = _render(
        "trade.md.j2",
        date="2026-05-21",
        order={
            "side": "buy",
            "symbol": "2330",
            "name": "TSMC",
            "price": 900,
            "shares": 1,
            "signal": "BUY",
            "confidence": 0.82,
            "source": "auto_ml",
        },
        decision={
            "sector": "Semiconductor",
            "score": 10,
            "total_score": 10,
            "chip_score": 1,
            "tech_score": 1,
            "ml_score": 1,
            "score_components": _score_v2_payload(91),
        },
    )

    assert "score: 91" in content
    assert "score_v2_source: score_v2" in content
    assert "**Score V2**: 91/100" in content
    assert "ML Edge 22.0/25 + Chip Flow 21.0/25 + Technical 20.0/25" in content
    assert "Chip 1/40" not in content
