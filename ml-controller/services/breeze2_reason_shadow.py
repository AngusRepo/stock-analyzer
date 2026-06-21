from __future__ import annotations

from typing import Any

from services.breeze2_research_context import build_breeze2_research_context_report
from services.llm_reason import build_canonical_candidate_payload, build_canonical_candidate_payloads


VALID_SCHEMA = "breeze2-research-context-v1"
GENERATION_SCHEMA = "breeze2-reason-generation-v1"


def _symbol(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or "").strip()


def _as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed == parsed else fallback


def _valid_report(report: Any) -> bool:
    return (
        isinstance(report, dict)
        and report.get("schema_version") == VALID_SCHEMA
        and report.get("allowed_use") == "research_context_only"
        and report.get("decision_effect") == "advisory_only"
    )


def _reason_context_label(context: str) -> str:
    if context == "candidate_context":
        return "題材佐證可作候選脈絡"
    if context == "watchlist_context":
        return "題材佐證偏觀察名單"
    if context == "human_review":
        return "題材熱度或佐證品質需人工複核"
    if context == "insufficient_evidence":
        return "可追溯佐證不足"
    return "語意脈絡待確認"


def _compact_score(value: Any) -> str:
    return f"{_as_float(value):.2f}"


def _domain_points(candidate: dict[str, Any]) -> list[str]:
    points = candidate.get("watch_points") or []
    if not isinstance(points, list):
        return []
    keep_prefixes = (
        "Alpha bucket:",
        "Alpha overlay:",
        "Market structure:",
        "Market structure unavailable:",
        "ML ensemble:",
    )
    return [
        point for point in points
        if isinstance(point, str) and point.strip() and point.startswith(keep_prefixes)
    ]


def _fallback_trade_plan(candidate: dict[str, Any], *, context: str, flags: list[str]) -> dict[str, str]:
    name = str(candidate.get("name") or candidate.get("stock_name") or candidate.get("symbol") or "").strip()
    market_structure = next((point for point in _domain_points(candidate) if point.startswith("Market structure:")), "")
    alpha = next((point for point in _domain_points(candidate) if point.startswith("Alpha bucket:")), "")
    flag_text = ", ".join(flags[:3]) if flags else "none"
    return {
        "bias": f"{name} 以 Breeze2 題材佐證作旁路判讀；context={context}。",
        "entry": market_structure or "等待系統買入區、轉強確認與量能延續，不用 Breeze2 文字直接追價。",
        "risk": f"題材/來源風險 flags={flag_text}；若 Score V2 或價量未延續，降權處理。",
        "target": alpha or "以上方壓力與 Alpha/日線結構上緣作研究用目標區，不視為保證價位。",
    }


def build_breeze2_reason_shadow(
    candidates: list[dict[str, Any]],
    reports_by_symbol: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Build non-mutating Breeze2 reason candidates for side-by-side review."""
    out: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        symbol = _symbol(candidate)
        if not symbol:
            continue
        report = reports_by_symbol.get(symbol)
        if not _valid_report(report):
            continue

        scores = report.get("scores") if isinstance(report.get("scores"), dict) else {}
        flags = [str(flag) for flag in report.get("risk_flags") or [] if flag]
        context = str(report.get("recommended_decision_context") or "unknown")
        label = _reason_context_label(context)
        name = str(candidate.get("name") or candidate.get("stock_name") or symbol)

        reason = (
            f"Breeze2 shadow：{name} {label}；"
            f"fact={_compact_score(scores.get('fact_support'))}, "
            f"hype={_compact_score(scores.get('hype_risk'))}, "
            f"quality={_compact_score(scores.get('source_quality'))}"
        )
        if flags:
            reason += f"；flags={','.join(flags[:4])}"

        watch_points = [
            (
                f"breeze2:{context} "
                f"fact={_compact_score(scores.get('fact_support'))} "
                f"hype={_compact_score(scores.get('hype_risk'))} "
                f"quality={_compact_score(scores.get('source_quality'))}"
            ),
            *_domain_points(candidate),
        ]

        out[symbol] = {
            "source": "breeze2_shadow",
            "decision_effect": "advisory_only",
            "reason": reason,
            "tradePlan": _fallback_trade_plan(candidate, context=context, flags=flags),
            "watchPoints": watch_points,
            "breeze2_context": context,
            "riskFlags": flags,
        }
    return out


def _candidate_payload(candidate: dict[str, Any]) -> dict[str, Any]:
    points = candidate.get("watch_points") or []
    if not isinstance(points, list):
        points = []
    return {
        "symbol": candidate.get("symbol"),
        "stock_name": candidate.get("stock_name") or candidate.get("name"),
        "trigger": "llm_reason_shadow",
        "reason": candidate.get("reason") or "breeze2_reason_shadow",
        "theme": candidate.get("theme") if isinstance(candidate.get("theme"), dict) else {},
        "news": candidate.get("news") if isinstance(candidate.get("news"), (dict, list)) else {},
        "evidence_items": candidate.get("evidence_items")
        if isinstance(candidate.get("evidence_items"), list)
        else [{"source": "stockvision_watch_point", "snippet": str(point)} for point in points if point],
        "metadata": {
            "score": candidate.get("score"),
            "signal": candidate.get("signal"),
            "source": "pipeline_v2_llm_reason_shadow",
        },
    }


def build_breeze2_reason_shadow_for_candidates(
    candidates: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    reports: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        symbol = _symbol(candidate)
        if not symbol:
            continue
        reports[symbol] = build_breeze2_research_context_report(
            _candidate_payload(candidate),
            executor="controller_local_reason_shadow",
        )
    return build_breeze2_reason_shadow(candidates, reports)


def build_breeze2_reason_shadow_for_canonical_payloads(
    canonical_candidate_payloads: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    reports: dict[str, dict[str, Any]] = {}
    for candidate in canonical_candidate_payloads:
        symbol = _symbol(candidate)
        if not symbol:
            continue
        reports[symbol] = build_breeze2_research_context_report(
            _candidate_payload(candidate),
            executor="controller_local_reason_shadow",
        )
    return build_breeze2_reason_shadow(canonical_candidate_payloads, reports)


def breeze2_reason_shadow_metrics(shadow: dict[str, dict[str, Any]]) -> dict[str, Any]:
    contexts: dict[str, int] = {}
    risk_flags: dict[str, int] = {}
    for entry in shadow.values():
        context = str(entry.get("breeze2_context") or "unknown")
        contexts[context] = contexts.get(context, 0) + 1
        for flag in entry.get("riskFlags") or []:
            key = str(flag)
            risk_flags[key] = risk_flags.get(key, 0) + 1
    return {
        "count": len(shadow),
        "contexts": contexts,
        "risk_flags": risk_flags,
    }


def _generation_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    return build_canonical_candidate_payload(candidate)


def build_breeze2_reason_generation_payload_from_canonical(
    canonical_candidate_payloads: list[dict[str, Any]],
    *,
    run_date: str | None = None,
    execute_model: bool = True,
) -> dict[str, Any]:
    return {
        "schema_version": "breeze2-reason-generation-request-v1",
        "allowed_use": "reason_shadow_only",
        "decision_effect": "advisory_only",
        "mutation_allowed": False,
        "real_trading_allowed": False,
        "primary_candidate_source_allowed": False,
        "provider_task": "breeze2_trade_plan",
        "provider": "breeze2",
        "run_date": run_date,
        "execute_model": bool(execute_model),
        "candidates": [
            dict(candidate)
            for candidate in canonical_candidate_payloads
            if isinstance(candidate, dict) and _symbol(candidate)
        ],
    }


def build_breeze2_reason_generation_payload(
    candidates: list[dict[str, Any]],
    *,
    run_date: str | None = None,
    execute_model: bool = True,
) -> dict[str, Any]:
    return build_breeze2_reason_generation_payload_from_canonical(
        build_canonical_candidate_payloads(candidates),
        run_date=run_date,
        execute_model=execute_model,
    )


def coerce_breeze2_reason_generation_report(report: Any) -> dict[str, dict[str, Any]]:
    if not (
        isinstance(report, dict)
        and report.get("schema_version") == GENERATION_SCHEMA
        and report.get("allowed_use") == "reason_shadow_only"
        and report.get("decision_effect") == "advisory_only"
        and report.get("primary_candidate_source_allowed") is False
    ):
        return {}
    reasons = report.get("reasons")
    if not isinstance(reasons, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for symbol, entry in reasons.items():
        if not isinstance(entry, dict):
            continue
        clean_symbol = str(symbol or entry.get("symbol") or "").strip()
        reason = str(entry.get("reason") or "").strip()
        if not clean_symbol or not reason:
            continue
        points = [
            str(point).strip()
            for point in (entry.get("watchPoints") or [])
            if isinstance(point, str) and point.strip()
        ][:3]
        trade_plan = entry.get("tradePlan") or entry.get("trade_plan") or {}
        if not isinstance(trade_plan, dict):
            trade_plan = {}
        out[clean_symbol] = {
            "source": str(entry.get("source") or "breeze2_generation_shadow"),
            "decision_effect": "advisory_only",
            "reason": reason,
            "tradePlan": {
                str(key): str(value).strip()
                for key, value in trade_plan.items()
                if str(key).strip() and str(value).strip()
            },
            "watchPoints": points,
            "breeze2_context": str(entry.get("breeze2_context") or "generation_shadow"),
            "riskFlags": [str(flag) for flag in (entry.get("riskFlags") or []) if flag],
        }
    return out


async def build_breeze2_generation_shadow_for_candidates(
    candidates: list[dict[str, Any]],
    *,
    run_date: str | None = None,
) -> dict[str, dict[str, Any]]:
    from services import modal_client

    report = await modal_client.breeze2_reason_generation(
        build_breeze2_reason_generation_payload(candidates, run_date=run_date, execute_model=True),
    )
    return coerce_breeze2_reason_generation_report(report)


async def build_breeze2_generation_shadow_for_canonical_payloads(
    canonical_candidate_payloads: list[dict[str, Any]],
    *,
    run_date: str | None = None,
) -> dict[str, dict[str, Any]]:
    from services import modal_client

    report = await modal_client.breeze2_reason_generation(
        build_breeze2_reason_generation_payload_from_canonical(
            canonical_candidate_payloads,
            run_date=run_date,
            execute_model=True,
        ),
    )
    return coerce_breeze2_reason_generation_report(report)
