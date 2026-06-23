"""Generate Score V2 recommendation reasons for Pipeline V2."""
from __future__ import annotations

import json
import logging
import math
import os
import re
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-3.5-flash"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

CANONICAL_CANDIDATE_PAYLOAD_SCHEMA = "stockvision-canonical-candidate-payload-v1"

SCORE_V2_WEIGHTS = {
    "mlEdge": 25.0,
    "chipFlow": 25.0,
    "technicalStructure": 25.0,
    "fundamentalQuality": 20.0,
    "newsTheme": 5.0,
}

SYSTEM_PROMPT = """你是台股投資研究助理，負責為每日推薦清單撰寫可驗證的推薦理由與交易計畫。

規則：
- 每支股票 reason 限 140 字內，必須使用 canonical candidate payload 裡的 Score V2 finalScore 與五構面語意。
- 五構面為 ML Edge、Chip Flow、Technical Structure、Fundamental Quality、News/Theme。
- 不可宣稱保證獲利、絕對勝率或水晶球式預測；請用條件式、風險可控的語氣。
- tradePlan 必須是研究用交易計畫，不得要求真實下單；需包含 bias、entry、risk、target。
- watchPoints 最多 3 點，必須是具體風險、觀察價量或資料品質提醒。
- 必須只回傳 JSON array，格式：
  [{"symbol":"2330","reason":"...","tradePlan":{"bias":"...","entry":"...","risk":"...","target":"..."},"watchPoints":["...","...","..."]}]
"""


REQUIRED_TRADE_PLAN_FIELDS = (
    "bias",
    "entry",
    "risk",
    "target",
    "invalidation",
    "positionSizing",
    "timeHorizon",
    "catalyst",
    "noTradeCondition",
)


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _round1(value: float) -> float:
    return round(float(value) * 10) / 10


def _clamp(value: Any, maximum: float) -> float:
    return _round1(max(0.0, min(float(maximum), _number(value))))


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
    """Build the single canonical candidate payload shared by Gemini and Breeze2."""
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


def build_gemini_trade_plan_request(
    canonical_candidate_payloads: list[dict[str, Any]],
    *,
    top_themes: Optional[list[str]] = None,
) -> dict[str, Any]:
    return {
        "schema_version": "stockvision-llm-trade-plan-request-v1",
        "provider_task": "gemini_trade_plan",
        "provider": "gemini",
        "model": GEMINI_MODEL,
        "top_themes": top_themes or [],
        "candidates": canonical_candidate_payloads,
    }


def _score_components(c: dict[str, Any]) -> dict[str, Any]:
    payload = _parse_score_components(c.get("score_components"))
    if payload:
        return payload
    components = {
        "mlEdge": _clamp((_number(c.get("ml_score")) / 30.0) * SCORE_V2_WEIGHTS["mlEdge"], SCORE_V2_WEIGHTS["mlEdge"]),
        "chipFlow": _clamp((_number(c.get("chip_score")) / 40.0) * SCORE_V2_WEIGHTS["chipFlow"], SCORE_V2_WEIGHTS["chipFlow"]),
        "technicalStructure": _clamp(
            ((_number(c.get("tech_score")) + _number(c.get("momentum_score"))) / 50.0) * SCORE_V2_WEIGHTS["technicalStructure"],
            SCORE_V2_WEIGHTS["technicalStructure"],
        ),
        "fundamentalQuality": 0.0,
        "newsTheme": 0.0,
    }
    total = _round1(sum(components.values()))
    final_score = _clamp(c.get("score", total), 100.0)
    return {
        "version": "score_v2",
        "components": components,
        "total": total,
        "alphaAdjustment": _round1(final_score - total),
        "finalScore": final_score,
        "formula": "score_v2_total + alphaAdjustment",
        "reasons": ["llm_reason_storage_projection"],
    }


def _component(payload: dict[str, Any], key: str) -> float:
    components = payload.get("components") if isinstance(payload.get("components"), dict) else {}
    return _clamp(components.get(key), SCORE_V2_WEIGHTS.get(key, 100.0))


def _score_context(c: dict[str, Any]) -> str:
    payload = _score_components(c)
    final_score = _clamp(payload.get("finalScore", payload.get("total")), 100.0)
    total = _clamp(payload.get("total"), 100.0)
    alpha = _round1(_number(payload.get("alphaAdjustment"), final_score - total))
    return (
        f"Score V2 finalScore={final_score:.1f}/100 "
        f"(base={total:.1f}, alpha={alpha:.1f}); "
        f"ML Edge={_component(payload, 'mlEdge'):.1f}/25, "
        f"Chip Flow={_component(payload, 'chipFlow'):.1f}/25, "
        f"Technical Structure={_component(payload, 'technicalStructure'):.1f}/25, "
        f"Fundamental Quality={_component(payload, 'fundamentalQuality'):.1f}/20, "
        f"News/Theme={_component(payload, 'newsTheme'):.1f}/5"
    )


def _build_stock_line(idx: int, c: dict[str, Any]) -> str:
    chip_amt = _number(c.get("foreign_net_5d")) + _number(c.get("trust_net_5d"))
    rsi = c.get("rsi14")
    rsi_str = f"{_number(rsi):.0f}" if rsi is not None else "N/A"
    conf_pct = _number(c.get("confidence", c.get("ml_confidence"))) * 100
    macd_h = _number(c.get("macd_hist"))
    vote_summary = c.get("ml_vote_summary_text") or c.get("ml_vote_summary") or "N/A"
    return (
        f"{idx + 1}. {c['symbol']} {c.get('name', '')} | "
        f"signal={c.get('signal', 'N/A')} | {_score_context(c)} | "
        f"ML vote={vote_summary}, conf={conf_pct:.0f}% | "
        f"RSI={rsi_str}, MACD={'positive' if macd_h > 0 else 'non-positive'} | "
        f"5d chip cash={chip_amt:.1f}B TWD | price={c.get('current_price', 'N/A')}"
    )


async def _call_gemini(user_prompt: str, n_candidates: int, timeout: float) -> Optional[str]:
    """Call Gemini. Returns raw text or None on failure."""
    if not GEMINI_API_KEY:
        return None
    url = f"{GEMINI_BASE}/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": min(4096, n_candidates * 400),
            "responseMimeType": "application/json",
        },
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=body, headers={"Content-Type": "application/json"})
        if resp.status_code != 200:
            logger.warning("[llm_reason] Gemini HTTP %s: %s", resp.status_code, resp.text[:200])
            return None
        data = resp.json()
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if not text:
            logger.warning("[llm_reason] Gemini returned empty text")
            return None
        usage = data.get("usageMetadata", {})
        tokens_in = int(usage.get("promptTokenCount", 0) or 0)
        tokens_out = int(usage.get("candidatesTokenCount", 0) or 0)
        logger.info("[llm_reason] Gemini OK tokens in=%s out=%s", tokens_in, tokens_out)
        try:
            from .cost_tracker import record_llm_call

            await record_llm_call(
                "llm_reason",
                "gemini",
                GEMINI_MODEL,
                tokens_in,
                tokens_out,
                meta={"n_candidates": n_candidates},
            )
        except Exception:
            pass
        return text
    except Exception as exc:
        logger.warning("[llm_reason] Gemini error: %s: %r", type(exc).__name__, exc)
        return None


def _trade_plan_from_item(item: dict[str, Any]) -> dict[str, str]:
    raw = item.get("tradePlan") or item.get("trade_plan") or {}
    if isinstance(raw, str):
        summary = _clean_text(raw, max_len=220)
        return {"summary": summary} if summary else {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    aliases = {
        "positionSizing": ("positionSizing", "position_sizing", "sizing", "size"),
        "timeHorizon": ("timeHorizon", "time_horizon", "horizon", "holdingPeriod"),
        "noTradeCondition": ("noTradeCondition", "no_trade_condition", "noTrade", "skipCondition"),
    }
    for key in REQUIRED_TRADE_PLAN_FIELDS:
        candidates = aliases.get(key, (key, key.lower()))
        text = _clean_text(next((raw.get(alias) for alias in candidates if raw.get(alias)), ""), max_len=180)
        if text:
            out[key] = text
    return out


def _missing_trade_plan_fields(entry: dict[str, Any]) -> list[str]:
    plan = entry.get("tradePlan") if isinstance(entry.get("tradePlan"), dict) else {}
    return [field for field in REQUIRED_TRADE_PLAN_FIELDS if not _clean_text(plan.get(field), max_len=220)]


def _mark_trade_plan_status(reasons: dict[str, dict], *, repair_attempted: bool = False) -> dict[str, list[str]]:
    invalid: dict[str, list[str]] = {}
    for symbol, entry in reasons.items():
        missing = _missing_trade_plan_fields(entry)
        entry["tradePlanRequiredFields"] = list(REQUIRED_TRADE_PLAN_FIELDS)
        entry["tradePlanRepairAttempted"] = repair_attempted or bool(entry.get("tradePlanRepairAttempted"))
        if missing:
            entry["tradePlanStatus"] = "plan_invalid_after_repair" if entry["tradePlanRepairAttempted"] else "plan_invalid_needs_repair"
            entry["tradePlanMissingFields"] = missing
            invalid[symbol] = missing
        else:
            entry["tradePlanStatus"] = "valid"
            entry["tradePlanMissingFields"] = []
    return invalid


def _parse_reasons(raw: str, n_candidates: int) -> dict[str, dict]:
    """Parse JSON array from raw LLM response text."""
    match = re.search(r"\[[\s\S]*\]", raw, re.DOTALL)
    if not match:
        logger.error("[llm_reason] No JSON array in response: %s", raw[:200])
        return {}
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        logger.error("[llm_reason] JSON parse failed: %s", exc)
        return {}

    result: dict[str, dict] = {}
    for item in parsed:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol") or "").strip()
        reason = item.get("reason")
        if symbol and reason:
            points = [
                _clean_text(point, max_len=180)
                for point in (item.get("watchPoints") or item.get("watch_points") or [])
                if str(point).strip()
            ][:3]
            result[symbol] = {
                "source": "gemini_3_5_flash",
                "provider": "gemini",
                "model": GEMINI_MODEL,
                "decision_effect": "advisory_only",
                "reason": _clean_text(reason, max_len=320),
                "tradePlan": _trade_plan_from_item(item),
                "watchPoints": points,
            }
    return result


def _build_trade_plan_repair_prompt(
    canonical_payload: dict[str, Any],
    parsed_reasons: dict[str, dict],
    invalid: dict[str, list[str]],
) -> str:
    repair_items = {
        symbol: {
            "missingFields": fields,
            "current": parsed_reasons.get(symbol, {}),
        }
        for symbol, fields in invalid.items()
    }
    return (
        "Repair the StockVision tradePlan JSON only for symbols with missing fields. "
        "Return a JSON array. Keep the same symbol, reason, and watchPoints when present. "
        "Do not add new candidates. Fill only missing tradePlan fields. "
        f"Required tradePlan fields={list(REQUIRED_TRADE_PLAN_FIELDS)}. "
        f"canonical_payload={json.dumps(canonical_payload, ensure_ascii=False, separators=(',', ':'))}. "
        f"invalid_items={json.dumps(repair_items, ensure_ascii=False, separators=(',', ':'))}."
    )


async def generate_recommendation_reasons_from_payloads(
    canonical_candidate_payloads: list[dict[str, Any]],
    top_themes: Optional[list[str]] = None,
    timeout: float = 60.0,
    max_attempts: int = 3,
) -> dict[str, dict]:
    if not canonical_candidate_payloads:
        return {}
    if not GEMINI_API_KEY:
        logger.warning("[llm_reason] No GEMINI_API_KEY set, skipping Gemini reason generation")
        return {}

    canonical_payload = build_gemini_trade_plan_request(canonical_candidate_payloads, top_themes=top_themes)
    user_prompt = (
        f"請為以下 {len(canonical_candidate_payloads)} 檔候選股票撰寫 Gemini 3.5 Flash 獨立交易計畫。\n"
        "只能使用 canonical_candidate_payload；不要讀取或推測 legacy score/ml_score/chip_score 欄位。\n"
        f"tradePlan_required_fields={json.dumps(list(REQUIRED_TRADE_PLAN_FIELDS), ensure_ascii=False)}\n"
        f"canonical_candidate_payload={json.dumps(canonical_payload, ensure_ascii=False, separators=(',', ':'))}"
    )

    raw = await _call_gemini(user_prompt, len(canonical_candidate_payloads), timeout)
    if raw is None:
        logger.error("[llm_reason] Gemini reason generation failed")
        return {}

    result = _parse_reasons(raw, len(canonical_candidate_payloads))
    invalid = _mark_trade_plan_status(result, repair_attempted=False)
    if invalid and max_attempts > 1:
        repair_prompt = _build_trade_plan_repair_prompt(canonical_payload, result, invalid)
        repair_raw = await _call_gemini(repair_prompt, len(invalid), min(timeout, 45.0))
        if repair_raw is not None:
            repaired = _parse_reasons(repair_raw, len(invalid))
            _mark_trade_plan_status(repaired, repair_attempted=True)
            for symbol, entry in repaired.items():
                if symbol in invalid:
                    entry["tradePlanRepairAttempted"] = True
                    if not _missing_trade_plan_fields(entry):
                        original = result.get(symbol, {})
                        original_plan = original.get("tradePlan") if isinstance(original.get("tradePlan"), dict) else {}
                        repaired_plan = entry.get("tradePlan") if isinstance(entry.get("tradePlan"), dict) else {}
                        result[symbol] = {
                            **entry,
                            **original,
                            "tradePlan": {**repaired_plan, **original_plan},
                            "tradePlanRepairAttempted": True,
                        }
        _mark_trade_plan_status(result, repair_attempted=True)
    logger.info("[llm_reason] Generated %s/%s Gemini reasons", len(result), len(canonical_candidate_payloads))
    return result


async def generate_recommendation_reasons(
    candidates: list[dict],
    top_themes: Optional[list[str]] = None,
    timeout: float = 60.0,
    max_attempts: int = 3,
) -> dict[str, dict]:
    return await generate_recommendation_reasons_from_payloads(
        build_canonical_candidate_payloads(candidates),
        top_themes=top_themes,
        timeout=timeout,
        max_attempts=max_attempts,
    )
    """
    Generate LLM reasons for recommendation candidates.

    Gemini 3.5 Flash only. No secondary LLM fallback is used in this path.
    Returns: {symbol: {"reason": str, "tradePlan": dict, "watchPoints": list[str]}}
    """
    _ = max_attempts  # Kept for call-site compatibility; retries belong in provider clients.
    if not candidates:
        return {}
    if not GEMINI_API_KEY:
        logger.warning("[llm_reason] No GEMINI_API_KEY set, skipping Gemini reason generation")
        return {}

    canonical_payload = {
        "schema_version": CANONICAL_CANDIDATE_PAYLOAD_SCHEMA,
        "provider_task": "gemini_trade_plan",
        "top_themes": top_themes or [],
        "candidates": build_canonical_candidate_payloads(candidates),
    }
    user_prompt = (
        f"請為以下 {len(candidates)} 檔候選股票撰寫 Gemini 3.5 Flash 獨立交易計畫。\n"
        "只能使用 canonical_candidate_payload，不可使用舊版 score/ml_score/chip_score 作正式輸入。\n"
        f"canonical_candidate_payload={json.dumps(canonical_payload, ensure_ascii=False, separators=(',', ':'))}"
    )

    raw = await _call_gemini(user_prompt, len(candidates), timeout)
    if raw is None:
        logger.error("[llm_reason] Gemini reason generation failed")
        return {}

    result = _parse_reasons(raw, len(candidates))
    logger.info("[llm_reason] Generated %s/%s Gemini reasons", len(result), len(candidates))
    return result
