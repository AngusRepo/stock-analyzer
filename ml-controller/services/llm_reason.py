"""Provider-neutral canonical recommendation payloads; no network generation."""
from __future__ import annotations

import json
import math
import re
from typing import Any

CANONICAL_CANDIDATE_PAYLOAD_SCHEMA = "stockvision-canonical-candidate-payload-v1"


def _parse_score_components(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
    if isinstance(value, dict) and value.get("version") == "score_v2" and isinstance(value.get("components"), dict):
        return value
    return None


def _clean_text(value: Any, max_len: int = 260) -> str:
    text = str(value or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text[:max_len]


def _clean_string_list(value: Any, *, limit: int = 6, max_len: int = 180) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = _clean_text(item, max_len=max_len)
        if text:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def _compact_json_value(value: Any, *, depth: int = 0) -> Any:
    """Keep canonical payload JSON prompt-safe without changing its schema keys."""
    if depth > 5:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    if isinstance(value, str):
        return _clean_text(value, max_len=600)
    if isinstance(value, list):
        return [_compact_json_value(item, depth=depth + 1) for item in value[:24]]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, nested in value.items():
            if key in {"reasonVariants", "reason_variants"}:
                continue
            out[str(key)] = _compact_json_value(nested, depth=depth + 1)
        return out
    return _clean_text(value, max_len=260)


def _canonical_score_components(candidate: dict[str, Any]) -> dict[str, Any] | None:
    payload = _parse_score_components(candidate.get("score_components"))
    if not payload:
        return None
    return _compact_json_value(payload)


def build_canonical_candidate_payload(candidate: dict[str, Any]) -> dict[str, Any]:
    """Build the single canonical candidate payload for advisory reason consumers."""
    score_components = _canonical_score_components(candidate)
    watch_points = _clean_string_list(candidate.get("watch_points"), limit=10, max_len=220)
    payload: dict[str, Any] = {
        "schema_version": CANONICAL_CANDIDATE_PAYLOAD_SCHEMA,
        "symbol": str(candidate.get("symbol") or "").strip(),
        "name": candidate.get("name") or candidate.get("stock_name"),
        "signal": candidate.get("signal"),
        "market_segment": candidate.get("market_segment"),
        "recommendation_lane": candidate.get("recommendation_lane"),
        "score_components_status": "ok" if score_components else "missing_score_v2",
        "score_components": score_components,
        "alpha_context": _compact_json_value(candidate.get("alpha_context")),
        "alpha_allocation": _compact_json_value(candidate.get("alpha_allocation")),
        "ml_vote_summary": _compact_json_value(candidate.get("ml_vote_summary")),
        "ml_vote_summary_text": _clean_text(candidate.get("ml_vote_summary_text"), max_len=260),
        "current_price": candidate.get("current_price"),
        "rsi14": candidate.get("rsi14"),
        "macd_hist": candidate.get("macd_hist"),
        "foreign_net_5d": candidate.get("foreign_net_5d"),
        "trust_net_5d": candidate.get("trust_net_5d"),
        "watch_points": watch_points,
        "reason_seed": _clean_text(candidate.get("reason"), max_len=260),
        "theme": _compact_json_value(candidate.get("theme") if isinstance(candidate.get("theme"), dict) else {}),
        "news": _compact_json_value(candidate.get("news") if isinstance(candidate.get("news"), (dict, list)) else {}),
        "evidence_items": _compact_json_value(candidate.get("evidence_items") if isinstance(candidate.get("evidence_items"), list) else []),
    }
    return {key: value for key, value in payload.items() if value not in (None, "", [], {})}


def build_canonical_candidate_payloads(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        payload
        for payload in (build_canonical_candidate_payload(candidate) for candidate in candidates)
        if payload.get("symbol")
    ]
