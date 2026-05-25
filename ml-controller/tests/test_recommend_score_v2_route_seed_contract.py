from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.recommend_score_v2_route import build_score_v2_route_candidate  # noqa: E402


def test_recommend_score_v2_route_uses_normalized_seed_inputs():
    candidate = build_score_v2_route_candidate(
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
            "screener_momentum_seed20": 16,
            "ml_signal": "STRONG_BUY",
            "ml_confidence": 0.9,
            "hist_accuracy": 0.62,
            "hist_count": 30,
        }
    )

    assert candidate.chip_flow_seed40 == pytest.approx(40.0)
    assert candidate.technical_seed30 == pytest.approx(30.0)
    assert candidate.screener_momentum_seed20 == pytest.approx(16.0)
    assert candidate.ml_edge_seed30 > 0
    assert not hasattr(candidate, "chip_score")
    assert not hasattr(candidate, "tech_score")
    assert not hasattr(candidate, "momentum_score")
    assert not hasattr(candidate, "ml_score")
    assert not hasattr(candidate, "score_components")
    assert candidate.score_v2["seedComponents"]["chipFlowSeed40"] == pytest.approx(candidate.chip_flow_seed40)
    assert candidate.score_v2["seedComponents"]["technicalSeed30"] == pytest.approx(candidate.technical_seed30)
    assert candidate.score_v2["seedComponents"]["screenerMomentumSeed20"] == pytest.approx(candidate.screener_momentum_seed20)
    assert candidate.score_v2["seedComponents"]["mlEdgeSeed30"] == pytest.approx(candidate.ml_edge_seed30)


def test_recommend_score_v2_route_does_not_accept_legacy_momentum_seed():
    candidate = build_score_v2_route_candidate(
        {
            "stock_id": 1,
            "symbol": "2330",
            "name": "TSMC",
            "current_price": 900,
            "foreign_net_5d": 0,
            "trust_net_5d": 0,
            "foreign_consecutive": 0,
            "momentum_score": 19,
        }
    )

    assert candidate.screener_momentum_seed20 == 0
    assert candidate.score_v2["seedComponents"]["screenerMomentumSeed20"] == 0


def test_recommend_score_v2_route_does_not_accept_stale_score_components():
    candidate = build_score_v2_route_candidate(
        {
            "stock_id": 1,
            "symbol": "2330",
            "name": "TSMC",
            "current_price": 900,
            "foreign_net_5d": 0,
            "trust_net_5d": 0,
            "foreign_consecutive": 0,
            "score": 99,
            "chip_score": 40,
            "tech_score": 30,
            "momentum_score": 20,
            "ml_score": 30,
            "score_components": {
                "version": "score_v2",
                "components": {
                    "mlEdge": 25,
                    "chipFlow": 25,
                    "technicalStructure": 25,
                    "fundamentalQuality": 20,
                    "newsTheme": 5,
                },
                "total": 100,
                "finalScore": 100,
            },
        }
    )

    assert candidate.score_v2["finalScore"] < 100
    assert candidate.score_v2["seedComponents"]["chipFlowSeed40"] == pytest.approx(candidate.chip_flow_seed40)
    assert candidate.score_v2["seedComponents"]["technicalSeed30"] == pytest.approx(candidate.technical_seed30)
    assert candidate.score_v2["seedComponents"]["screenerMomentumSeed20"] == 0
    assert candidate.score_v2["components"]["chipFlow"] < 25


def test_recommend_score_v2_route_builds_components_from_seed_inputs():
    source = Path("ml-controller/services/recommend_score_v2_route.py").read_text(encoding="utf-8")
    helper_start = source.index("def _score_v2_builder_row")
    helper_end = source.index("def build_score_v2_route_candidate", helper_start)
    helper_block = source[helper_start:helper_end]
    start = source.index("def build_score_v2_route_candidate")
    end = source.index("def rank_score_v2_route_candidates", start)
    block = source[start:end]

    assert '"score_seed_inputs": score_seed_inputs' in helper_block
    assert "raw_score=sum(score_seed_inputs.values())" in block
    assert "**stock" not in block
    assert "**stock" not in helper_block
    assert "_score_v2_builder_row(" in block
    for legacy_mapping in ["chip_score", "tech_score", "momentum_score", "ml_score", "score_components"]:
        assert legacy_mapping not in helper_block
    for legacy_mapping in ["chip_score", "tech_score", "momentum_score", "ml_score"]:
        assert legacy_mapping not in block
