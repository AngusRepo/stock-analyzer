"""
debate_service.py — Multi-round Bull/Bear debate for Paper Trading

Python port of worker/src/lib/debateTrader.ts runBuyDebate.
Preserves:
  - 3-agent pattern: Zealot (bull) → Reaper (bear) → Fulcrum (judge)
  - Multi-round debate loop (1..max_rounds, default 2) with rebuttal
  - Prompt injection detection (DANGER_PATTERNS)
  - Verdict parsing (APPROVE | DOWNGRADE | REJECT) + conviction 0-100
  - KV cache for 24h dedup
  - Stock profile + US/TAIFEX context injection

Removed from TS version:
  - Local Tunnel + Workers AI layers (Worker-only bindings)

See: worker/src/lib/debateTrader.ts (authoritative source; any prompt tweak
     must update both files until TS version is retired).
"""
from __future__ import annotations
import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from services.llm_debate_client import call_llm

logger = logging.getLogger(__name__)


# ── Prompt injection patterns (ported 1:1 from TS) ────────────────────────────
DANGER_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"ignore\s+(all\s+)?(previous|above|prior)\s+(instruction|prompt|rule)", re.IGNORECASE), "critical", "instruction_override"),
    (re.compile(r"disregard\s+(everything|all|the)\s+(above|previous)", re.IGNORECASE), "critical", "instruction_override"),
    (re.compile(r"forget\s+(your|all|previous)\s+(instruction|rule|prompt)", re.IGNORECASE), "critical", "instruction_override"),
    (re.compile(r"you\s+are\s+now\s+a", re.IGNORECASE), "critical", "role_hijack"),
    (re.compile(r"\b(all[\s-]?in|go\s+all\s+in)\b", re.IGNORECASE), "high", "extreme_action"),
    (re.compile(r"\b(sell\s+everything|liquidate\s+all|dump\s+all)\b", re.IGNORECASE), "high", "extreme_action"),
    (re.compile(r"\b(buy\s+maximum|max\s+position|maximum\s+leverage)\b", re.IGNORECASE), "high", "extreme_action"),
    (re.compile(r"\b(guaranteed|risk[\s-]?free|cannot\s+lose|sure\s+thing)\b", re.IGNORECASE), "medium", "unrealistic_claim"),
    (re.compile(r"\b(insider\s+(info|tip|knowledge)|confidential\s+(info|source)|secret\s+info|tip\s+from\s+(a|an|my)\s+(friend|source))\b", re.IGNORECASE), "high", "insider_claim"),
    (re.compile(r"\b(act\s+now|immediately|urgent|don'?t\s+wait|must\s+buy\s+today)\b", re.IGNORECASE), "medium", "urgency_manipulation"),
]

# Zero-width Unicode chars to strip before matching (VULN-31 fix)
_ZWSP_RE = re.compile(r"[\u200B\u200C\u200D\u2060\uFEFF\u00AD]")


def _check_injection(raw_text: str) -> dict:
    text = _ZWSP_RE.sub("", raw_text)
    matches: list[dict] = []
    for regex, severity, desc in DANGER_PATTERNS:
        if regex.search(text):
            matches.append({"pattern": desc, "severity": severity})
    if not matches:
        return {"action": "pass", "severity": "none", "matches": []}
    has_critical = any(m["severity"] == "critical" for m in matches)
    has_high = any(m["severity"] == "high" for m in matches)
    return {
        "action": "reject" if has_critical else "downgrade",
        "severity": "critical" if has_critical else ("high" if has_high else "medium"),
        "matches": matches,
    }


def _parse_verdict(response: str) -> str:
    upper = response.upper()
    first_line = upper.split("\n", 1)[0] if upper else ""
    if "REJECT" in first_line:
        return "REJECT"
    if "DOWNGRADE" in first_line:
        return "DOWNGRADE"
    if "APPROVE" in first_line:
        return "APPROVE"
    if "REJECT" in upper:
        return "REJECT"
    if "DOWNGRADE" in upper:
        return "DOWNGRADE"
    return "APPROVE"


def _parse_conviction(response: str) -> int:
    m = re.search(r"CONVICTION:\s*(\d+)", response, re.IGNORECASE)
    if m:
        val = int(m.group(1))
        return max(0, min(100, val))
    v = _parse_verdict(response)
    return {"APPROVE": 75, "DOWNGRADE": 50, "REJECT": 25}[v]


def _parse_json_array_from_str(raw: Optional[str], max_items: int = 3) -> str:
    if not raw:
        return ""
    import json as _json
    try:
        arr = _json.loads(raw)
        if isinstance(arr, list):
            return "；".join(str(x) for x in arr[:max_items])
    except Exception:
        pass
    return (raw or "")[:200]


# ── KV helpers (reads via CF API) ─────────────────────────────────────────────

_CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID", "619a83ac9f20847d9e2f2920823b727d")
_CF_KV_NS_ID   = os.environ.get("CF_KV_NAMESPACE_ID", "39dcebcf5b6848c98f269ef9a48dc3f8")
_CF_API_TOKEN  = os.environ.get("CF_API_TOKEN", "")


async def _read_max_rounds(client: httpx.AsyncClient) -> int:
    """Read ml:config.debate_max_rounds from KV (bounded 1..3, default 2)."""
    if not _CF_API_TOKEN:
        return 2
    try:
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{_CF_ACCOUNT_ID}"
            f"/storage/kv/namespaces/{_CF_KV_NS_ID}/values/ml:config.debate_max_rounds"
        )
        resp = await client.get(url, headers={"Authorization": f"Bearer {_CF_API_TOKEN}"}, timeout=5.0)
        if resp.status_code == 200:
            try:
                n = int(resp.text.strip())
                return max(1, min(3, n))
            except ValueError:
                return 2
        return 2
    except Exception:
        return 2


async def _kv_read(client: httpx.AsyncClient, key: str) -> Optional[str]:
    if not _CF_API_TOKEN:
        return None
    try:
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{_CF_ACCOUNT_ID}"
            f"/storage/kv/namespaces/{_CF_KV_NS_ID}/values/{key}"
        )
        resp = await client.get(url, headers={"Authorization": f"Bearer {_CF_API_TOKEN}"}, timeout=5.0)
        if resp.status_code == 200:
            return resp.text
        return None
    except Exception:
        return None


async def _kv_write(client: httpx.AsyncClient, key: str, value: str, ttl_seconds: int = 86400) -> bool:
    if not _CF_API_TOKEN:
        return False
    try:
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{_CF_ACCOUNT_ID}"
            f"/storage/kv/namespaces/{_CF_KV_NS_ID}/values/{key}?expiration_ttl={ttl_seconds}"
        )
        resp = await client.put(
            url,
            headers={"Authorization": f"Bearer {_CF_API_TOKEN}", "Content-Type": "text/plain"},
            content=value,
            timeout=10.0,
        )
        return resp.status_code == 200
    except Exception as e:
        logger.warning(f"[Debate] KV write failed: {e}")
        return False


# ── Data shapes ───────────────────────────────────────────────────────────────

@dataclass
class StockProfile:
    business_desc: Optional[str] = None
    key_customers: Optional[str] = None
    key_suppliers: Optional[str] = None


@dataclass
class DebateResult:
    verdict: str             # APPROVE | DOWNGRADE | REJECT
    rounds: int              # total rounds counter (2*debate_rounds + 1 for Fulcrum)
    summary: str             # <=500 chars, goes into paper_orders.note
    llm_source: str          # gemini_api | anthropic_api
    conviction_score: int    # 0-100


# ── Prompts (zh-TW, ported 1:1 from TS) ───────────────────────────────────────

_ZEALOT_SYS_BASE = "\n".join([
    "你是 Zealot — 一位極度樂觀的多頭交易員。",
    "你的信念：每一支被 ML 模型選中的股票都有獨到的買入理由。",
    "",
    "規則：",
    "- 不准說「但是」「不過」「風險」「需要注意」，你是死多頭",
    "- 把 ML 信號、技術面、籌碼面的正面訊號放大解讀",
    "- 簡潔有力，用繁體中文回答。",
])

_REAPER_SYS_BASE = "\n".join([
    "你是 Reaper — 一位極度悲觀的空頭風控分析師（融合 Charlie Munger + Michael Burry）。",
    "你的信念：任何看起來完美的交易都藏著致命缺陷。",
    "",
    "挑戰角度：",
    "【價值面】估值合理性、護城河是否真實",
    "【動能面】技術疲態、追高風險、量價背離",
    "【宏觀面】總經/地緣尾部風險",
    "",
    "規則：",
    "- 不准說「優點是」「看好」「值得買入」，你是死空頭",
    "- 每個挑戰都要具體，不要空泛警告",
    "- 用繁體中文回答。",
])

_FULCRUM_SYS_PROMPT = "\n".join([
    "你是 Fulcrum — 一位冷靜公正的交易裁決者。你只看證據，不被情緒左右。",
    "",
    "第一行輸出格式（嚴格遵守）：",
    "VERDICT: <APPROVE|DOWNGRADE|REJECT> CONVICTION: <0-100>",
    "",
    "判決標準：",
    "APPROVE — 風險可控，Zealot 論點有力（conviction >= 70）",
    "DOWNGRADE — 有合理疑慮，減半倉位（conviction 40-69）",
    "REJECT — Reaper 指出的風險無法忽視（conviction < 40）",
    "",
    "conviction score = 你對此交易的信念程度（0=完全不信 100=極度看好）。",
    "",
    "第二行起用繁體中文寫 1-2 句判決理由。不要有其他格式。",
])


# ── Main: runBuyDebate equivalent ─────────────────────────────────────────────

async def run_buy_debate(
    symbol: str,
    stock_name: str,
    signal: str,
    confidence: float,
    reasoning: str,
    us_context: Optional[str] = None,
    stock_profile: Optional[StockProfile] = None,
    taifex_context: Optional[str] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> DebateResult:
    close_client = False
    if client is None:
        client = httpx.AsyncClient()
        close_client = True

    # #44 W5 A/B routing — deterministic per (symbol, TW date)
    from .debate_ab import assign_model, log_debate
    ab_model = assign_model(symbol)

    try:
        # ── Compose mlContext (matches TS ordering) ────────────────────────
        profile_lines: list[str] = []
        if stock_profile:
            if stock_profile.business_desc:
                desc = stock_profile.business_desc.replace("**", "")[:250]
                profile_lines.append(f"【公司概況】{desc}")
            customers = _parse_json_array_from_str(stock_profile.key_customers, 3)
            if customers:
                profile_lines.append(f"【主要客戶】{customers.replace('**', '')[:150]}")
            suppliers = _parse_json_array_from_str(stock_profile.key_suppliers, 3)
            if suppliers:
                profile_lines.append(f"【主要供應商】{suppliers.replace('**', '')[:150]}")

        ml_context_parts: list[str] = [
            f"Stock: {symbol} ({stock_name})",
            f"Signal: {signal} | Confidence: {confidence * 100:.1f}%",
        ]
        if us_context:
            ml_context_parts.append(f"【美股前夜】{us_context}")
        if taifex_context:
            ml_context_parts.append(f"【台指期夜盤】{taifex_context}")
        ml_context_parts.extend(profile_lines)
        ml_context_parts.append("ML Ensemble Reasoning:")
        ml_context_parts.append(reasoning)
        ml_context = "\n".join(ml_context_parts)

        # ── Read config ────────────────────────────────────────────────────
        max_rounds = await _read_max_rounds(client)
        logger.info(f"[Debate] {symbol} max_rounds={max_rounds}")

        zealot_cases: list[str] = []
        reaper_cases: list[str] = []
        llm_source = "unknown"
        rounds_completed = 0

        for r in range(1, max_rounds + 1):
            is_initial = r == 1
            max_tokens = 512 if is_initial else 256

            # ── Zealot turn ────────────────────────────────────────────────
            if is_initial:
                zealot_system = _ZEALOT_SYS_BASE + "\n\n你的任務：根據 ML 數據和公司資訊，寫出 3-5 個強力看多理由。最多 300 字。"
                zealot_prompt = f"Write the bull case:\n\n{ml_context}"
            else:
                zealot_system = _ZEALOT_SYS_BASE + f"\n\n你的任務：讀對方（Reaper）剛才的空方論點，針對其每個挑戰回擊反駁。最多 180 字。"
                prev_reaper = reaper_cases[-1] if reaper_cases else ""
                zealot_prompt = "\n".join([
                    "=== 原始 BUY context ===",
                    ml_context,
                    "",
                    f"=== Reaper Round {r - 1} 挑戰 ===",
                    prev_reaper,
                    "",
                    f"你的反駁（Round {r}）：",
                ])
            try:
                text, source = await call_llm(
                    zealot_system, zealot_prompt, temperature=0.5,
                    max_tokens=max_tokens, client=client, ab_force=ab_model,
                )
                zealot_cases.append(text)
                llm_source = source
                logger.info(f"[Debate] {symbol} Zealot R{r} done via {source}")
            except Exception as e:
                logger.warning(f"[Debate] {symbol} Zealot R{r} failed: {e}")
                if is_initial:
                    zealot_cases.append(ml_context)
                else:
                    break

            # ── Reaper turn ────────────────────────────────────────────────
            if is_initial:
                reaper_system = _REAPER_SYS_BASE + "\n\n你的任務：提出 3-5 個致命挑戰，最多 300 字。"
                reaper_prompt = f"Challenge this BUY case:\n\n{ml_context}"
            else:
                reaper_system = _REAPER_SYS_BASE + "\n\n你的任務：讀對方（Zealot）剛才的反駁，再挑出新的弱點或未被回應的風險。最多 180 字。"
                prev_zealot = zealot_cases[-1] if zealot_cases else ""
                reaper_prompt = "\n".join([
                    "=== 原始 BUY context ===",
                    ml_context,
                    "",
                    f"=== Zealot Round {r} 反駁 ===",
                    prev_zealot,
                    "",
                    f"你的再反擊（Round {r}）：",
                ])
            try:
                text, source = await call_llm(
                    reaper_system, reaper_prompt, temperature=0.7,
                    max_tokens=max_tokens, client=client, ab_force=ab_model,
                )
                reaper_cases.append(text)
                llm_source = source
                logger.info(f"[Debate] {symbol} Reaper R{r} done via {source}")
            except Exception as e:
                logger.warning(f"[Debate] {symbol} Reaper R{r} failed: {e}")
                if is_initial:
                    return DebateResult(
                        verdict="APPROVE",
                        rounds=1,
                        summary=(f"Zealot only (Reaper LLM error R1): {zealot_cases[0] if zealot_cases else ''}")[:500],
                        llm_source=llm_source,
                        conviction_score=60,
                    )
                break

            rounds_completed = r

        zealot_case = "\n\n--- 下一輪 ---\n\n".join(zealot_cases)
        reaper_case = "\n\n--- 下一輪 ---\n\n".join(reaper_cases)

        # ── Fulcrum judge ───────────────────────────────────────────────────
        fulcrum_user_prompt = "\n".join([
            "=== ZEALOT CASE (極度看多) ===",
            zealot_case,
            "",
            "=== REAPER CASE (極度看空) ===",
            reaper_case,
            "",
            "Your verdict (APPROVE / DOWNGRADE / REJECT):",
        ])

        total_rounds = 2 * rounds_completed + 1
        try:
            fulcrum_response, source = await call_llm(
                _FULCRUM_SYS_PROMPT, fulcrum_user_prompt,
                temperature=0.2, max_tokens=256, client=client, ab_force=ab_model,
            )
            llm_source = source
            logger.info(f"[Debate] Fulcrum done for {symbol} via {source} (totalRounds={total_rounds})")
        except Exception as e:
            logger.warning(f"[Debate] Fulcrum round failed for {symbol}: {e}")
            return DebateResult(
                verdict="APPROVE",
                rounds=total_rounds - 1,
                summary=(f"Zealot+Reaper done (Fulcrum error). "
                         f"Zealot: {zealot_case[:200]} | Reaper: {reaper_case[:200]}")[:500],
                llm_source=llm_source,
                conviction_score=60,
            )

        # Injection detection on Reaper + Fulcrum (Zealot is LLM-rewrite, trust)
        injection = _check_injection("\n".join([reaper_case, fulcrum_response]))
        if injection["action"] == "reject":
            logger.warning(f"[Debate] INJECTION DETECTED for {symbol}: {[m['pattern'] for m in injection['matches']]}")
            return DebateResult(
                verdict="REJECT",
                rounds=total_rounds,
                summary=f"[INJECTION_BLOCKED] {','.join(m['pattern'] for m in injection['matches'])}"[:500],
                llm_source=llm_source,
                conviction_score=0,
            )

        verdict = _parse_verdict(fulcrum_response)
        conviction = _parse_conviction(fulcrum_response)

        if injection["action"] == "downgrade" and verdict == "APPROVE":
            logger.warning(f"[Debate] Injection downgrade for {symbol}: {[m['pattern'] for m in injection['matches']]}")
            verdict = "DOWNGRADE"

        summary_parts = [f"[{verdict}|conv:{conviction}|rounds:{rounds_completed}|{llm_source}] "]
        if injection["action"] != "pass":
            summary_parts.append(f"[INJ:{injection['severity']}] ")
        reaper_last = (reaper_cases[-1] if reaper_cases else "")[:100]
        summary_parts.append(f"Reaper(last): {reaper_last} | ")
        fulcrum_stripped = re.sub(r"VERDICT:.*\n?", "", fulcrum_response).strip()[:150]
        summary_parts.append(f"Fulcrum: {fulcrum_stripped}")
        summary = "".join(summary_parts)[:500]

        result = DebateResult(
            verdict=verdict,
            rounds=total_rounds,
            summary=summary,
            llm_source=llm_source,
            conviction_score=conviction,
        )
        # #44 fire-and-forget A/B log (only when ab_model assigned)
        if ab_model:
            try:
                await log_debate(
                    symbol=symbol,
                    model_assigned=ab_model,
                    model_actual=llm_source,
                    verdict=verdict,
                    conviction_score=float(conviction) if conviction is not None else None,
                    summary_len=len(summary),
                    debate_rounds=total_rounds,
                )
            except Exception:
                pass
        return result
    finally:
        if close_client:
            await client.aclose()


# ── KV cache wrapper ─────────────────────────────────────────────────────────

async def run_buy_debate_cached(
    symbol: str,
    stock_name: str,
    signal: str,
    confidence: float,
    reasoning: str,
    us_context: Optional[str] = None,
    stock_profile: Optional[StockProfile] = None,
    taifex_context: Optional[str] = None,
    cache_key_date: Optional[str] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> DebateResult:
    """24h-cache wrapper. Same semantics as the TS version of
    `paper:debate:{symbol}:{date}` lookup in setupMorningPendingBuys."""
    import json as _json
    from datetime import datetime, timezone, timedelta

    close_client = False
    if client is None:
        client = httpx.AsyncClient()
        close_client = True

    try:
        cache_date = cache_key_date or (
            datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
        )
        cache_key = f"paper:debate:{symbol}:{cache_date}"
        cached = await _kv_read(client, cache_key)
        if cached:
            try:
                payload = _json.loads(cached)
                logger.info(f"[Debate] {symbol} cached → {payload.get('verdict')}")
                return DebateResult(
                    verdict=payload.get("verdict", "APPROVE"),
                    rounds=payload.get("rounds", 0),
                    summary=payload.get("summary", ""),
                    llm_source=payload.get("llm_source", "cached"),
                    conviction_score=payload.get("conviction_score", 60),
                )
            except Exception:
                pass

        result = await run_buy_debate(
            symbol=symbol, stock_name=stock_name,
            signal=signal, confidence=confidence, reasoning=reasoning,
            us_context=us_context, stock_profile=stock_profile,
            taifex_context=taifex_context, client=client,
        )

        # Persist to KV for 24h dedup
        await _kv_write(
            client, cache_key,
            _json.dumps({
                "verdict": result.verdict,
                "rounds": result.rounds,
                "summary": result.summary,
                "llm_source": result.llm_source,
                "conviction_score": result.conviction_score,
            }),
            ttl_seconds=86400,
        )
        return result
    finally:
        if close_client:
            await client.aclose()


# ── Batch endpoint helper ─────────────────────────────────────────────────────

async def run_buy_debate_batch(
    candidates: list[dict],
    concurrent: int = 5,
) -> list[dict]:
    """Run multiple buy debates concurrently.

    candidates: list of dicts with keys {symbol, stock_name, signal, confidence,
                reasoning, us_context, stock_profile, taifex_context}
    concurrent: asyncio.Semaphore bound (Modal Gemini rate: ~60/min so 5 is safe)

    Returns list of dicts: {symbol, verdict, rounds, summary, llm_source,
                            conviction_score, error?}
    """
    results: list[dict] = []
    sem = asyncio.Semaphore(concurrent)

    async with httpx.AsyncClient() as client:
        async def _one(cand: dict) -> dict:
            async with sem:
                symbol = cand.get("symbol", "?")
                try:
                    profile = None
                    p = cand.get("stock_profile")
                    if p:
                        profile = StockProfile(
                            business_desc=p.get("business_desc"),
                            key_customers=p.get("key_customers"),
                            key_suppliers=p.get("key_suppliers"),
                        )
                    result = await run_buy_debate_cached(
                        symbol=symbol,
                        stock_name=cand.get("stock_name", symbol),
                        signal=cand.get("signal", "BUY"),
                        confidence=float(cand.get("confidence", 0.6)),
                        reasoning=cand.get("reasoning", ""),
                        us_context=cand.get("us_context"),
                        stock_profile=profile,
                        taifex_context=cand.get("taifex_context"),
                        cache_key_date=cand.get("cache_key_date"),
                        client=client,
                    )
                    return {
                        "symbol": symbol,
                        "verdict": result.verdict,
                        "rounds": result.rounds,
                        "summary": result.summary,
                        "llm_source": result.llm_source,
                        "conviction_score": result.conviction_score,
                    }
                except Exception as e:
                    logger.error(f"[Debate] {symbol} batch crashed: {e}")
                    return {"symbol": symbol, "error": str(e)}

        results = await asyncio.gather(*[_one(c) for c in candidates], return_exceptions=False)
    return results
