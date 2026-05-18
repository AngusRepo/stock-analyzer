from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers.breeze2 import Breeze2FactCheckRequest, breeze2_fact_check  # noqa: E402


def test_breeze2_router_dry_run_builds_non_mutating_context_packet():
    req = Breeze2FactCheckRequest(
        symbol="2330",
        trigger="morning_debate",
        reason="theme_score_high_but_fact_support_low",
        theme={"theme_score": 0.86, "fact_support": 0.25, "hype_risk": 0.8},
        evidence_items=[{"source": "social", "snippet": "topic momentum but no source url"}],
        execute_modal=False,
        generated_at="2026-05-17T09:10:00+08:00",
    )

    report = asyncio.run(breeze2_fact_check(req))

    assert report["schema_version"] == "breeze2-research-context-v1"
    assert report["execution"]["executor"] == "controller_local_contract"
    assert report["allowed_use"] == "research_context_only"
    assert report["recommended_decision_context"] == "human_review"
    assert report["primary_candidate_source_allowed"] is False


def test_breeze2_router_rejects_mutating_or_real_trade_scope():
    req = Breeze2FactCheckRequest(
        symbol="2330",
        trigger="screener_enrichment",
        reason="bad_scope",
        mutation_allowed=True,
    )

    try:
        asyncio.run(breeze2_fact_check(req))
    except Exception as exc:  # noqa: BLE001 - route raises HTTPException.
        assert "cannot mutate" in str(exc).lower()
    else:
        raise AssertionError("breeze2 route must reject mutating scope")
