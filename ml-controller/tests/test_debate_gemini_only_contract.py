from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import debate_ab, llm_debate_client  # noqa: E402


def test_debate_assignment_is_gemini_only(monkeypatch):
    monkeypatch.setattr(debate_ab, "_ENABLED", True)

    assignments = {
        debate_ab.assign_model("2330", date=f"2026-06-{day:02d}")
        for day in range(1, 15)
    }

    assert assignments == {"gemini"}


def test_debate_assignment_can_be_disabled(monkeypatch):
    monkeypatch.setattr(debate_ab, "_ENABLED", False)

    assert debate_ab.assign_model("2330", date="2026-06-22") is None


def test_debate_client_no_anthropic_api_surface():
    source = Path(llm_debate_client.__file__).read_text(encoding="utf-8")

    assert "ANTHROPIC_API_KEY" not in source
    assert "api.anthropic.com" not in source
    assert "anthropic_api" not in source
    assert 'return "anthropic"' not in Path(debate_ab.__file__).read_text(encoding="utf-8")


def test_debate_client_ignores_legacy_anthropic_ab_force(monkeypatch):
    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {
                "candidates": [
                    {"content": {"parts": [{"text": "VERDICT: APPROVE CONVICTION: 75"}]}}
                ],
                "usageMetadata": {},
            }

    class FakeClient:
        def __init__(self):
            self.urls: list[str] = []

        async def post(self, url: str, **kwargs):
            self.urls.append(url)
            return FakeResponse()

    monkeypatch.setattr(llm_debate_client, "GEMINI_API_KEY", "test-key")
    client = FakeClient()

    text, source = asyncio.run(
        llm_debate_client.call_llm(
            "system",
            "user",
            client=client,  # type: ignore[arg-type]
            ab_force="anthropic",
        )
    )

    assert text == "VERDICT: APPROVE CONVICTION: 75"
    assert source == "gemini_api"
    assert client.urls
    assert "generativelanguage.googleapis.com" in client.urls[0]
