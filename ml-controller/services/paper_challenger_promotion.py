"""Paper-active challenger promotion contract.

This layer lets new V4 data/factor candidates influence paper decisions while
keeping all real-order authority outside the automatic path.
"""

from __future__ import annotations

from typing import Any


PAPER_CHALLENGER_PROMOTION_SCHEMA_VERSION = "paper-challenger-promotion-v1"

DEFAULT_POLICY = {
    "min_paper_decisions": 30,
    "max_precision_at_k_drop": 0.01,
    "max_hit_rate_drop": 0.01,
    "max_avg_return_drop_pct": 0.25,
    "max_drawdown_worsening_pct": 1.0,
    "max_turnover_increase": 1.5,
    "min_topk_overlap": 0.65,
    "min_precision_at_k_gain": 0.02,
    "min_hit_rate_gain": 0.02,
    "min_avg_return_gain_pct": 0.35,
    "min_runtime_speedup_pct": 10.0,
}


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def _permissions(*, can_influence_paper_decision: bool) -> dict[str, bool]:
    return {
        "can_influence_paper_decision": bool(can_influence_paper_decision),
        "can_write_paper_attribution": bool(can_influence_paper_decision),
        "can_write_order": False,
        "can_submit_real_order": False,
        "can_write_real_risk_state": False,
    }


def _gate(passed: bool, metrics: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "passed": bool(passed),
        "reason": reason,
        "metrics": metrics,
    }


def _quality_gates(
    baseline_metrics: dict[str, Any],
    challenger_metrics: dict[str, Any],
    policy: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    precision_delta = _num(challenger_metrics.get("precision_at_k")) - _num(baseline_metrics.get("precision_at_k"))
    hit_rate_delta = _num(challenger_metrics.get("hit_rate")) - _num(baseline_metrics.get("hit_rate"))
    avg_return_delta = _num(challenger_metrics.get("avg_return_pct")) - _num(baseline_metrics.get("avg_return_pct"))
    drawdown_delta = _num(challenger_metrics.get("max_drawdown_pct")) - _num(baseline_metrics.get("max_drawdown_pct"))
    turnover_delta = _num(challenger_metrics.get("turnover_ratio")) - _num(baseline_metrics.get("turnover_ratio"))
    topk_overlap = _num(challenger_metrics.get("topk_overlap"), default=0.0)
    decision_count = int(_num(challenger_metrics.get("paper_decision_count"), default=0))
    runtime_speedup = _num(challenger_metrics.get("runtime_speedup_pct"), default=0.0)
    blind_spot = bool(challenger_metrics.get("blind_spot_coverage"))

    sample_passed = decision_count >= int(policy["min_paper_decisions"])
    non_inferior = (
        precision_delta >= -float(policy["max_precision_at_k_drop"])
        and hit_rate_delta >= -float(policy["max_hit_rate_drop"])
        and avg_return_delta >= -float(policy["max_avg_return_drop_pct"])
        and drawdown_delta >= -float(policy["max_drawdown_worsening_pct"])
        and turnover_delta <= float(policy["max_turnover_increase"])
        and topk_overlap >= float(policy["min_topk_overlap"])
        and challenger_metrics.get("regime_split_passed") is True
    )
    incremental = (
        precision_delta >= float(policy["min_precision_at_k_gain"])
        or hit_rate_delta >= float(policy["min_hit_rate_gain"])
        or avg_return_delta >= float(policy["min_avg_return_gain_pct"])
        or blind_spot
    )
    runtime_efficiency = runtime_speedup >= float(policy["min_runtime_speedup_pct"])

    return {
        "sample_size": _gate(
            sample_passed,
            {"paper_decision_count": decision_count, "min_paper_decisions": int(policy["min_paper_decisions"])},
            "enough_paper_decisions" if sample_passed else "insufficient_paper_decisions",
        ),
        "non_inferiority": _gate(
            non_inferior,
            {
                "precision_at_k_delta": _round(precision_delta),
                "hit_rate_delta": _round(hit_rate_delta),
                "avg_return_delta_pct": _round(avg_return_delta),
                "max_drawdown_delta_pct": _round(drawdown_delta),
                "turnover_delta": _round(turnover_delta),
                "topk_overlap": _round(topk_overlap),
                "regime_split_passed": challenger_metrics.get("regime_split_passed") is True,
            },
            "paper_quality_preserved" if non_inferior else "paper_quality_regressed",
        ),
        "incremental_value": _gate(
            incremental,
            {
                "precision_at_k_delta": _round(precision_delta),
                "hit_rate_delta": _round(hit_rate_delta),
                "avg_return_delta_pct": _round(avg_return_delta),
                "blind_spot_coverage": challenger_metrics.get("blind_spot_coverage"),
            },
            "incremental_value_detected" if incremental else "no_incremental_value_yet",
        ),
        "runtime_efficiency": _gate(
            runtime_efficiency,
            {"runtime_speedup_pct": _round(runtime_speedup, 2), "min_runtime_speedup_pct": float(policy["min_runtime_speedup_pct"])},
            "runtime_gain_detected" if runtime_efficiency else "runtime_not_material",
        ),
    }


def build_paper_challenger_promotion_packet(
    *,
    candidate_id: str,
    current_state: str,
    baseline_metrics: dict[str, Any],
    challenger_metrics: dict[str, Any],
    generated_at: str | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    active_policy = {**DEFAULT_POLICY, **(policy or {})}
    gates = _quality_gates(baseline_metrics, challenger_metrics, active_policy)
    failed_gates = [name for name, gate in gates.items() if name != "runtime_efficiency" and not gate["passed"]]

    if not gates["sample_size"]["passed"]:
        decision = "KEEP_PAPER_ACTIVE"
        next_state = "paper_active_challenger"
    elif not gates["non_inferiority"]["passed"]:
        decision = "DEMOTE_TO_CLEAN_ASSET"
        next_state = "clean_asset"
    elif gates["incremental_value"]["passed"]:
        decision = "PROMOTE_TO_PAPER_PRIMARY"
        next_state = "paper_primary"
    else:
        decision = "KEEP_PAPER_ACTIVE"
        next_state = "paper_active_challenger"

    can_influence = next_state in {"paper_active_challenger", "paper_primary"}
    if decision == "DEMOTE_TO_CLEAN_ASSET":
        can_influence = False

    return {
        "schema_version": PAPER_CHALLENGER_PROMOTION_SCHEMA_VERSION,
        "generated_at": generated_at,
        "candidate_id": str(candidate_id),
        "current_state": str(current_state),
        "decision": decision,
        "next_state": next_state,
        "quality_gates": gates,
        "failed_gates": failed_gates,
        "baseline_metrics": baseline_metrics,
        "challenger_metrics": challenger_metrics,
        "permissions": _permissions(can_influence_paper_decision=can_influence),
        "real_trading_effect": "none",
        "requires_wei_approval_for_real": True,
        "real_review_packet": {
            "status": "not_auto_generated",
            "reason": "paper_promotion_never_grants_real_trading_authority",
        },
    }


def build_paper_decision_attribution(
    *,
    symbol: str,
    trade_date: str,
    decision: str,
    baseline_score: float,
    challenger_score: float,
    challenger_id: str,
    feature_set_version: str,
    regime_version: str,
    evidence_sources: list[str] | None = None,
    paper_lane: str = "paper_active_challenger",
) -> dict[str, Any]:
    base = float(baseline_score)
    challenger = float(challenger_score)
    return {
        "schema_version": "paper-decision-attribution-v1",
        "audit_table": "paper_decision_attribution",
        "symbol": str(symbol),
        "trade_date": str(trade_date),
        "decision": str(decision),
        "paper_lane": str(paper_lane),
        "candidate_source": str(challenger_id),
        "baseline_score": _round(base, 6),
        "challenger_score": _round(challenger, 6),
        "decision_delta": _round(challenger - base, 6),
        "feature_set_version": str(feature_set_version),
        "regime_version": str(regime_version),
        "evidence_sources": list(evidence_sources or []),
        "can_write_order": False,
        "can_submit_real_order": False,
    }


def build_paper_promotion_audit_event(
    packet: dict[str, Any],
    *,
    from_state: str | None = None,
) -> dict[str, Any]:
    return {
        "candidate_id": str(packet.get("candidate_id") or "unknown"),
        "from_state": from_state or str(packet.get("current_state") or "unknown"),
        "to_state": str(packet.get("next_state") or "unknown"),
        "decision": str(packet.get("decision") or "unknown"),
        "failed_gates": list(packet.get("failed_gates") or []),
        "packet": packet,
        "real_trading_effect": "none",
    }


def build_paper_challenger_postmarket_report(
    *,
    candidates: list[dict[str, Any]],
    baseline_metrics_by_candidate: dict[str, dict[str, Any]],
    challenger_metrics_by_candidate: dict[str, dict[str, Any]],
    generated_at: str | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    packets: list[dict[str, Any]] = []
    audit_events: list[dict[str, Any]] = []
    summary: dict[str, int] = {}
    missing_metrics: list[str] = []

    for candidate in candidates or []:
        candidate_id = str(candidate.get("candidate_id") or candidate.get("id") or "unknown")
        baseline = baseline_metrics_by_candidate.get(candidate_id)
        challenger = challenger_metrics_by_candidate.get(candidate_id)
        if baseline is None or challenger is None:
            missing_metrics.append(candidate_id)
            continue
        packet = build_paper_challenger_promotion_packet(
            candidate_id=candidate_id,
            current_state=str(candidate.get("current_state") or "paper_active_challenger"),
            baseline_metrics=baseline,
            challenger_metrics=challenger,
            generated_at=generated_at,
            policy=policy,
        )
        packet["candidate_type"] = str(candidate.get("candidate_type") or "unknown")
        packets.append(packet)
        audit_events.append(
            build_paper_promotion_audit_event(
                packet,
                from_state=str(candidate.get("current_state") or "paper_active_challenger"),
            )
        )
        decision = str(packet.get("decision") or "unknown")
        summary[decision] = summary.get(decision, 0) + 1

    return {
        "schema_version": "paper-challenger-postmarket-report-v1",
        "generated_at": generated_at,
        "candidate_count": len(candidates or []),
        "evaluated_count": len(packets),
        "missing_metrics": missing_metrics,
        "summary": summary,
        "promotion_packets": packets,
        "audit_events": audit_events,
        "real_trading_effect": "none",
    }


def validate_paper_challenger_promotion_packet(packet: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if packet.get("schema_version") != PAPER_CHALLENGER_PROMOTION_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    permissions = packet.get("permissions") if isinstance(packet.get("permissions"), dict) else {}
    if permissions.get("can_write_order") is True:
        errors.append("paper_challenger_must_not_write_order")
    if permissions.get("can_submit_real_order") is True:
        errors.append("paper_challenger_must_not_submit_real_order")
    if packet.get("real_trading_effect") != "none":
        errors.append("paper_promotion_must_not_have_real_trading_effect")
    if packet.get("requires_wei_approval_for_real") is not True:
        errors.append("real_trading_review_must_require_wei_approval")
    if packet.get("decision") == "PROMOTE_TO_PAPER_PRIMARY" and packet.get("next_state") != "paper_primary":
        errors.append("paper_primary_promotion_state_mismatch")
    return errors
