from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers.debate import BuyDebateRequest  # noqa: E402
from services.debate_service import format_breeze2_context_block  # noqa: E402


def test_debate_request_accepts_breeze2_context_sidecar():
    req = BuyDebateRequest(
        symbol="2330",
        stock_name="台積電",
        breeze2_context={
            "allowed_use": "research_context_only",
            "recommended_decision_context": "human_review",
            "scores": {"fact_support": 0.31, "hype_risk": 0.76, "source_quality": 0.2},
            "risk_flags": ["fact_support_low", "hype_risk_high"],
        },
    )

    assert req.breeze2_context["allowed_use"] == "research_context_only"


def test_debate_formats_breeze2_context_without_granting_decision_authority():
    block = format_breeze2_context_block(
        {
            "allowed_use": "research_context_only",
            "decision_effect": "advisory_only",
            "recommended_decision_context": "human_review",
            "scores": {"fact_support": 0.31, "hype_risk": 0.76, "source_quality": 0.2},
            "risk_flags": ["fact_support_low", "hype_risk_high"],
        }
    )

    assert "Breeze2 semantic context" in block
    assert "research_context_only" in block
    assert "advisory_only" in block
    assert "fact_support_low" in block
    assert "decision authority: none" in block
