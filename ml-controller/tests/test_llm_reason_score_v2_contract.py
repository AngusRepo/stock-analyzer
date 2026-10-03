from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import llm_reason  # noqa: E402
from services.breeze2_reason_shadow import build_breeze2_reason_generation_payload_from_canonical  # noqa: E402


def test_llm_reason_generation_path_does_not_expose_anthropic_fallback():
    assert not hasattr(llm_reason, "ANTHROPIC_API_KEY")
    assert not hasattr(llm_reason, "_call_anthropic")


def _score_v2_payload() -> dict:
    return {
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
        "alphaAdjustment": 3,
        "finalScore": 88,
    }


def _candidate() -> dict:
    return {
        "symbol": "2330",
        "name": "TSMC",
        "signal": "BUY",
        "score": 10,
        "chip_score": 1,
        "tech_score": 1,
        "momentum_score": 0,
        "ml_score": 1,
        "score_components": _score_v2_payload(),
        "foreign_net_5d": 2.1,
        "trust_net_5d": 0.4,
        "rsi14": 60,
        "macd_hist": 1.2,
        "confidence": 0.81,
        "current_price": 900,
    }


def test_canonical_candidate_payload_prefers_score_v2_and_excludes_legacy_scores():
    payload = llm_reason.build_canonical_candidate_payload(_candidate())

    assert payload["schema_version"] == "stockvision-canonical-candidate-payload-v1"
    assert payload["score_components_status"] == "ok"
    assert payload["score_components"]["finalScore"] == 88
    assert payload["score_components"]["components"]["mlEdge"] == 22
    for legacy_key in ("score", "ml_score", "chip_score", "tech_score", "momentum_score"):
        assert legacy_key not in payload


def test_advisory_payload_preserves_canonical_score_and_filters_recursive_variants():
    candidate = _candidate()
    candidate["score_components"]["reasonVariants"] = {"old": {"reason": "not input evidence"}}
    canonical = llm_reason.build_canonical_candidate_payloads([candidate, {"symbol": ""}])
    request = build_breeze2_reason_generation_payload_from_canonical(
        canonical, run_date="2026-10-03", execute_model=True)
    assert request["candidates"] == canonical
    assert len(canonical) == 1
    assert canonical[0]["score_components"]["finalScore"] == 88
    assert "reasonVariants" not in canonical[0]["score_components"]
    assert "reasonVariants" in candidate["score_components"]
    json.dumps(request, allow_nan=False)


def test_pipeline_keeps_template_reasons_without_external_generation(monkeypatch):
    import asyncio
    from copy import deepcopy
    import httpx
    from graphs import daily_pipeline_v2 as pipeline

    def unexpected_request(*args, **kwargs):
        raise AssertionError("recommendation reasons must not call an external provider")

    monkeypatch.setattr(httpx.AsyncClient, "post", unexpected_request)
    monkeypatch.setattr(httpx.Client, "post", unexpected_request)
    candidates = [{**_candidate(), "reason": "verified template evidence"}]
    before = deepcopy(candidates)
    result = asyncio.run(pipeline.node_llm_reasons({
        "final_recommendations": candidates, "run_date": "2026-10-03"}))
    assert result == {"llm_reasons": {}, "breeze2_reason_shadow": {}}
    assert candidates == before
