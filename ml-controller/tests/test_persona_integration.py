"""
test_persona_integration.py — integration test for persona_score wiring
into recommendation_service.filter_and_score_recommendations.

Verifies:
  - persona_score adds to total_score
  - persona_weight=0 disables the feature
  - symbols without persona_opinions contribute 0
  - persona_applied meta is populated correctly
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.recommendation_service import filter_and_score_recommendations  # noqa: E402
from services.persona_service import (  # noqa: E402
    TrustOpinion,
    RetailOpinion,
)


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _screener_rec(symbol: str, chip: float = 20.0, tech: float = 15.0) -> dict:
    return {
        "id": 1,
        "date": "2026-04-16",
        "symbol": symbol,
        "name": symbol,
        "sector": "半導體",
        "industry": "晶圓代工",
        "chip_score": chip,
        "tech_score": tech,
    }


def _prediction(signal: str = "BUY", confidence: float = 0.72) -> dict:
    return {
        "signal": signal,
        "confidence": confidence,
        "forecast_pct": 0.02,
        "direction": "up",
        "ensemble_votes": {"up": 7, "down": 2, "neutral": 2},
    }


def _payload(symbol: str) -> dict:
    return {
        "symbol": symbol,
        "prices": [{"date": "2026-04-15", "close": 1000.0, "open": 995.0, "high": 1005.0, "low": 990.0}],
        "indicators": [{"date": "2026-04-15", "rsi14": 55.0, "macdHist": 0.5}],
        "chips": [{"date": "2026-04-15", "foreign_net": 1000, "trust_net": 500}],
        "sentiment_scores": [],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Tests
# ═══════════════════════════════════════════════════════════════════════════

class TestPersonaIntegration:
    def test_no_persona_opinions_leaves_score_unchanged(self):
        recs = [_screener_rec("2330")]
        preds = {"2330": _prediction()}
        payloads = [_payload("2330")]
        final, _ = filter_and_score_recommendations(recs, preds, payloads)
        assert len(final) == 1
        row = final[0]
        assert row["persona_score"] == 0.0
        assert row["persona_applied"] is None
        # score = chip + tech + ml_score (persona absent)
        assert row["score"] == pytest.approx(row["chip_score"] + row["tech_score"] + row["ml_score"], abs=0.2)

    def test_strong_bullish_persona_adds_positive_score(self):
        recs = [_screener_rec("2330")]
        preds = {"2330": _prediction()}
        payloads = [_payload("2330")]
        opinions = {
            "2330": {
                "trust": TrustOpinion("BUY", 0.8, "strong").to_dict(),
                "retail": RetailOpinion("BUY", 0.6, "panic").to_dict(),
            }
        }
        final, _ = filter_and_score_recommendations(recs, preds, payloads, persona_opinions=opinions)
        row = final[0]
        # +10*0.8 + 5*0.6 = 8 + 3 = 11
        assert row["persona_score"] == pytest.approx(11.0, abs=0.1)
        assert row["persona_applied"]["trust_signal"] == "BUY"
        assert row["persona_applied"]["retail_signal"] == "BUY"

    def test_euphoric_retail_subtracts_from_score(self):
        recs = [_screener_rec("2330")]
        preds = {"2330": _prediction()}
        payloads = [_payload("2330")]
        opinions = {
            "2330": {
                "trust": TrustOpinion("NEUTRAL", 0.0, "n").to_dict(),
                "retail": RetailOpinion("CAUTION", 0.8, "euphoric").to_dict(),
            }
        }
        final, _ = filter_and_score_recommendations(recs, preds, payloads, persona_opinions=opinions)
        row = final[0]
        # -5 * 0.8 = -4
        assert row["persona_score"] == pytest.approx(-4.0, abs=0.1)

    def test_persona_weight_zero_disables_feature(self):
        recs = [_screener_rec("2330")]
        preds = {"2330": _prediction()}
        payloads = [_payload("2330")]
        opinions = {
            "2330": {
                "trust": TrustOpinion("BUY", 1.0, "max").to_dict(),
                "retail": RetailOpinion("BUY", 1.0, "max").to_dict(),
            }
        }
        final, _ = filter_and_score_recommendations(
            recs, preds, payloads, persona_opinions=opinions, persona_weight=0.0,
        )
        row = final[0]
        assert row["persona_score"] == 0.0

    def test_persona_weight_half_halves_contribution(self):
        recs = [_screener_rec("2330")]
        preds = {"2330": _prediction()}
        payloads = [_payload("2330")]
        opinions = {
            "2330": {
                "trust": TrustOpinion("BUY", 1.0, "max").to_dict(),
                "retail": RetailOpinion("NEUTRAL", 0.0, "n").to_dict(),
            }
        }
        final, _ = filter_and_score_recommendations(
            recs, preds, payloads, persona_opinions=opinions, persona_weight=0.5,
        )
        row = final[0]
        # trust BUY strength=1.0 → +10 * 0.5 = +5
        assert row["persona_score"] == pytest.approx(5.0, abs=0.1)

    def test_mix_of_symbols_with_and_without_opinions(self):
        # Some symbols have persona data, others don't — should coexist safely
        recs = [_screener_rec("2330"), _screener_rec("2454")]
        preds = {"2330": _prediction(), "2454": _prediction()}
        payloads = [_payload("2330"), _payload("2454")]
        opinions = {
            "2330": {
                "trust": TrustOpinion("BUY", 0.7, "t").to_dict(),
                "retail": RetailOpinion("NEUTRAL", 0.0, "n").to_dict(),
            }
            # 2454 missing on purpose
        }
        final, _ = filter_and_score_recommendations(recs, preds, payloads, persona_opinions=opinions)
        by_sym = {r["symbol"]: r for r in final}
        assert by_sym["2330"]["persona_score"] == pytest.approx(7.0, abs=0.1)
        assert by_sym["2454"]["persona_score"] == 0.0
        assert by_sym["2454"]["persona_applied"] is None
