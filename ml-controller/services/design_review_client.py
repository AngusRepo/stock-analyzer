"""Gemini-backed UI/UX design review helper.

This is intentionally narrow: it is not a generic LLM proxy. The controller
keeps GEMINI_API_KEY server-side and only accepts bounded UI/UX review inputs.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_DESIGN_REVIEW_MODEL", "gemini-3.5-flash")
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


SYSTEM_PROMPT = """You are StockVision's external UI/UX design reviewer.
StockVision is an industrial dark quantitative trading workstation combining:
- market research and topic discovery
- AI agent debate and model provenance
- ML pipeline / scheduler / infrastructure observability
- paper-trading risk control

Review only UI/UX, information architecture, visual hierarchy, data density,
interaction clarity, and operator trust. Do not discuss secrets, credentials,
deployment steps, or trading advice.

Return strict JSON with this shape:
{
  "summary": "short zh-TW executive summary",
  "north_star": "one sentence design direction",
  "findings": [
    {
      "priority": "P0|P1|P2|P3",
      "area": "navigation|research|dashboard|observability|visual_system|copy|workflow",
      "issue": "what is wrong",
      "recommendation": "specific fix",
      "rationale": "why this improves operator speed/trust"
    }
  ],
  "experiments": [
    {
      "name": "experiment name",
      "change": "small implementable UI change",
      "success_metric": "how to judge if it works"
    }
  ]
}
Use Traditional Chinese for all prose.
"""


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[clipped]"


def build_design_review_prompt(payload: dict[str, Any]) -> str:
    """Create a bounded prompt from already-validated request data."""
    artifacts = payload.get("artifacts") or []
    rendered_artifacts = []
    for artifact in artifacts[:8]:
        name = _clip(str(artifact.get("name", "artifact")), 120)
        kind = _clip(str(artifact.get("kind", "text")), 40)
        content = _clip(str(artifact.get("content", "")), 12_000)
        rendered_artifacts.append(f"## {name} ({kind})\n{content}")

    focus = payload.get("focus") or []
    focus_text = "\n".join(f"- {_clip(str(item), 160)}" for item in focus[:10]) or "- no explicit focus"

    return "\n\n".join([
        f"Objective:\n{_clip(str(payload.get('objective', 'Review StockVision UI/UX')), 1_000)}",
        f"Focus:\n{focus_text}",
        f"Current notes:\n{_clip(str(payload.get('current_notes') or ''), 2_000)}",
        "Artifacts:\n" + ("\n\n".join(rendered_artifacts) if rendered_artifacts else "No artifacts supplied."),
        "Provide practical recommendations that can be implemented incrementally without a full rewrite.",
    ])


async def call_gemini_design_review(
    payload: dict[str, Any],
    *,
    timeout_sec: float = 45.0,
    temperature: float = 0.35,
    max_output_tokens: int = 2048,
) -> dict[str, Any]:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not configured")

    user_prompt = build_design_review_prompt(payload)
    url = f"{GEMINI_BASE}/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
            "responseMimeType": "application/json",
        },
    }

    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        resp = await client.post(url, json=body, headers={"Content-Type": "application/json"})

    if resp.status_code != 200:
        logger.warning("[design-review] Gemini HTTP %s: %s", resp.status_code, resp.text[:240])
        raise RuntimeError(f"Gemini HTTP {resp.status_code}")

    data = resp.json()
    parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [{}])
    text = parts[0].get("text", "")
    if not text:
        raise RuntimeError("Gemini returned empty review")

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = {"summary": text, "north_star": "", "findings": [], "experiments": []}

    usage = data.get("usageMetadata") or {}
    return {
        "model": GEMINI_MODEL,
        "source": "gemini_api",
        "usage": {
            "prompt_tokens": int(usage.get("promptTokenCount", 0) or 0),
            "output_tokens": int(usage.get("candidatesTokenCount", 0) or 0),
            "total_tokens": int(usage.get("totalTokenCount", 0) or 0),
        },
        "review": parsed,
    }
