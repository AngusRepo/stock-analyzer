"""V4 promotion gate contract.

This module is a thin governance layer above feature/evidence-specific gates.
It decides which runtime lane a new FinLab field, external evidence source, or
research challenger may enter without becoming a production owner.
"""

from __future__ import annotations

from typing import Any


PROMOTION_GATE_SCHEMA_VERSION = "promotion-gate-contract-v2"

CLEANING_REQUIRED_GATES = [
    "source_lineage",
    "schema_freshness",
    "no_lookahead",
]

PROMOTION_REQUIRED_GATES = [
    "ic",
    "hit_rate",
    "transaction_cost",
    "turnover",
    "drawdown",
    "mae_mfe",
    "regime_split",
    "decision_engine_review",
]

SIMILARITY_EVIDENCE_CANDIDATE_TYPES = {
    "similarity_evidence",
    "clustering_evidence",
    "graph_similarity_evidence",
    "strategy_similarity_evidence",
}

SIMILARITY_PROMOTION_REQUIRED_GATES = [
    "no_new_selector",
    "no_hardcoded_cluster_count",
    "no_topk_fallback",
    "l15_pairwise_corr_not_worse",
    "l2_l3_quality_not_down",
    "l4_cluster_concentration_down",
    "backtest_sharpe_bias_fixed",
    "evening_chain_runtime_acceptable",
]

PAPER_ACTIVE_REQUIRED_GATES = [
    "backtest_reality",
    "walk_forward",
    "liquidity",
    "transaction_cost",
    "mae_mfe",
    "regime_split",
    "decision_engine_review",
    "paper_attribution",
]

PAPER_PRIMARY_REQUIRED_GATES = [
    *PAPER_ACTIVE_REQUIRED_GATES,
    "paper_order_ab",
    "paper_non_inferiority",
]

FORBIDDEN_RUNTIMES = {"trade_signal", "auto_order", "real_order", "paper_order"}
FORBIDDEN_PRODUCTION_EFFECTS = {"direct_alpha", "trade_signal", "auto_order"}
FORBIDDEN_PERMISSION_FLAGS = [
    "can_write_106_feature",
    "can_write_ml_vote",
    "can_write_regime",
    "can_write_order",
]


def _bool_evidence(evidence: dict[str, Any], name: str) -> bool:
    value = evidence.get(name)
    if isinstance(value, dict):
        return bool(value.get("passed") or value.get("gate_pass"))
    return bool(value)


def _gate(name: str, evidence: dict[str, Any]) -> dict[str, Any]:
    passed = _bool_evidence(evidence, name)
    return {
        "name": name,
        "passed": passed,
        "evidence": evidence.get(name),
    }


def _numeric_gate(
    name: str,
    evidence: dict[str, Any],
    predicate,
) -> dict[str, Any]:
    raw = evidence.get(name)
    if isinstance(raw, dict):
        if raw.get("passed") is not None or raw.get("gate_pass") is not None:
            return {
                "name": name,
                "passed": bool(raw.get("passed") or raw.get("gate_pass")),
                "evidence": raw,
            }
        raw = raw.get("value")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return {
            "name": name,
            "passed": False,
            "evidence": evidence.get(name),
        }
    return {
        "name": name,
        "passed": bool(predicate(value)),
        "evidence": evidence.get(name),
    }


def _similarity_promotion_gates(evidence: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        _gate("no_new_selector", evidence),
        _gate("no_hardcoded_cluster_count", evidence),
        _gate("no_topk_fallback", evidence),
        _numeric_gate("l15_pairwise_corr_not_worse", evidence, lambda value: value <= 0),
        _numeric_gate("l2_l3_quality_not_down", evidence, lambda value: value >= 0),
        _numeric_gate("l4_cluster_concentration_down", evidence, lambda value: value <= 0),
        _gate("backtest_sharpe_bias_fixed", evidence),
        _gate("evening_chain_runtime_acceptable", evidence),
    ]


def validate_similarity_evidence_promotion(evidence: dict[str, Any]) -> list[str]:
    gates = _similarity_promotion_gates(evidence)
    return [gate["name"] for gate in gates if not gate["passed"]]


def _permissions(**overrides: bool) -> dict[str, bool]:
    base = {
        "can_write_clean_asset": False,
        "can_write_feature_lake": False,
        "can_write_paper_attribution": False,
        "can_influence_paper_decision": False,
        "can_write_106_feature": False,
        "can_write_ml_vote": False,
        "can_write_regime": False,
        "can_write_order": False,
    }
    base.update({key: bool(value) for key, value in overrides.items()})
    return base


def _decision_packet(
    candidate: dict[str, Any],
    evidence: dict[str, Any],
    *,
    generated_at: str,
    decision: str,
    allowed_runtime: str,
    production_effect: str = "none",
    promotion_ready: bool = False,
    paper_active_ready: bool = False,
    permissions: dict[str, bool] | None = None,
    gates: list[dict[str, Any]] | None = None,
    failed_gates: list[str] | None = None,
) -> dict[str, Any]:
    lane = str(candidate.get("lane") or "unknown")
    return {
        "schema_version": PROMOTION_GATE_SCHEMA_VERSION,
        "generated_at": generated_at,
        "candidate_id": str(candidate.get("candidate_id") or "unknown"),
        "candidate_type": str(candidate.get("candidate_type") or "unknown"),
        "lane": lane,
        "requested_runtime": str(candidate.get("requested_runtime") or "unknown"),
        "decision": decision,
        "allowed_runtime": allowed_runtime,
        "production_effect": production_effect,
        "promotion_ready": promotion_ready,
        "paper_active_ready": paper_active_ready,
        "promotion_owner": "decision_engine_and_model_registry_review",
        "permissions": permissions or _permissions(),
        "gates": gates or [],
        "failed_gates": failed_gates or [],
        "evidence_digest": {key: evidence.get(key) for key in sorted(evidence)},
    }


def build_v4_promotion_packet(
    candidate: dict[str, Any],
    evidence: dict[str, Any],
    *,
    generated_at: str,
) -> dict[str, Any]:
    lane = str(candidate.get("lane") or "").strip().upper()
    candidate_type = str(candidate.get("candidate_type") or "").strip()
    requested_runtime = str(candidate.get("requested_runtime") or "").strip()
    cleaning_gates = [_gate(name, evidence) for name in CLEANING_REQUIRED_GATES]
    promotion_gates = [_gate(name, evidence) for name in PROMOTION_REQUIRED_GATES]
    paper_active_gates = [_gate(name, evidence) for name in PAPER_ACTIVE_REQUIRED_GATES]
    paper_primary_gates = [_gate(name, evidence) for name in PAPER_PRIMARY_REQUIRED_GATES]
    cleaning_failed = [gate["name"] for gate in cleaning_gates if not gate["passed"]]
    promotion_failed = [gate["name"] for gate in promotion_gates if not gate["passed"]]
    paper_active_failed = [gate["name"] for gate in paper_active_gates if not gate["passed"]]
    paper_primary_failed = [gate["name"] for gate in paper_primary_gates if not gate["passed"]]
    similarity_gates: list[dict[str, Any]] = []
    if candidate_type in SIMILARITY_EVIDENCE_CANDIDATE_TYPES:
        similarity_gates = _similarity_promotion_gates(evidence)
        promotion_failed = [
            *promotion_failed,
            *[gate["name"] for gate in similarity_gates if not gate["passed"]],
        ]
    all_gates = cleaning_gates + promotion_gates + similarity_gates

    if requested_runtime in FORBIDDEN_RUNTIMES:
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="BLOCK",
            allowed_runtime="blocked",
            gates=all_gates,
            failed_gates=["requested_runtime_not_allowed"],
        )

    if lane == "REJECT":
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="REJECT",
            allowed_runtime="blocked",
            gates=all_gates,
            failed_gates=["reject_lane"],
        )

    if lane == "P2":
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="RESEARCH_BENCHMARK_ONLY",
            allowed_runtime="offline_research",
            gates=all_gates,
        )

    if lane not in {"P0", "P1"}:
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="BLOCK",
            allowed_runtime="blocked",
            gates=all_gates,
            failed_gates=["lane_not_allowed"],
        )

    if cleaning_failed:
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="BLOCK",
            allowed_runtime="blocked",
            gates=all_gates,
            failed_gates=cleaning_failed,
        )

    if lane == "P0" and requested_runtime == "clean_asset":
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="ACCEPT_CLEAN_ASSET",
            allowed_runtime="clean_asset",
            permissions=_permissions(can_write_clean_asset=True),
            gates=all_gates,
        )

    if requested_runtime == "paper_active_challenger":
        gates = cleaning_gates + paper_active_gates
        if paper_active_failed:
            return _decision_packet(
                candidate,
                evidence,
                generated_at=generated_at,
                decision="BLOCK",
                allowed_runtime="feature_lake_shadow",
                permissions=_permissions(can_write_feature_lake=True),
                gates=gates,
                failed_gates=paper_active_failed,
            )
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="ALLOW_PAPER_ACTIVE_CHALLENGER",
            allowed_runtime="paper_active_challenger",
            production_effect="paper_decision_only",
            paper_active_ready=True,
            permissions=_permissions(
                can_write_feature_lake=True,
                can_write_paper_attribution=True,
                can_influence_paper_decision=True,
            ),
            gates=gates,
        )

    if requested_runtime == "paper_primary":
        gates = cleaning_gates + paper_primary_gates
        if paper_primary_failed:
            return _decision_packet(
                candidate,
                evidence,
                generated_at=generated_at,
                decision="BLOCK",
                allowed_runtime="paper_active_challenger",
                production_effect="paper_decision_only",
                permissions=_permissions(
                    can_write_feature_lake=True,
                    can_write_paper_attribution=True,
                    can_influence_paper_decision=True,
                ),
                gates=gates,
                failed_gates=paper_primary_failed,
            )
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="ALLOW_PAPER_PRIMARY",
            allowed_runtime="paper_primary",
            production_effect="paper_primary_only",
            paper_active_ready=True,
            permissions=_permissions(
                can_write_feature_lake=True,
                can_write_paper_attribution=True,
                can_influence_paper_decision=True,
            ),
            gates=gates,
        )

    if requested_runtime == "production_feature":
        if promotion_failed:
            return _decision_packet(
                candidate,
                evidence,
                generated_at=generated_at,
                decision="BLOCK",
                allowed_runtime="feature_lake_shadow",
                permissions=_permissions(can_write_feature_lake=True),
                gates=all_gates,
                failed_gates=promotion_failed,
            )
        return _decision_packet(
            candidate,
            evidence,
            generated_at=generated_at,
            decision="ALLOW_PROMOTION_REVIEW",
            allowed_runtime="promotion_review",
            production_effect="review_only",
            promotion_ready=True,
            gates=all_gates,
        )

    return _decision_packet(
        candidate,
        evidence,
        generated_at=generated_at,
        decision="SHADOW_TEST",
        allowed_runtime="feature_lake_shadow",
        permissions=_permissions(can_write_feature_lake=True),
        gates=all_gates,
    )


def validate_v4_promotion_packet(packet: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if packet.get("schema_version") != PROMOTION_GATE_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if packet.get("production_effect") in FORBIDDEN_PRODUCTION_EFFECTS:
        errors.append("direct_alpha_production_effect_not_allowed")
    permissions = packet.get("permissions") if isinstance(packet.get("permissions"), dict) else {}
    for flag in FORBIDDEN_PERMISSION_FLAGS:
        if permissions.get(flag) is True:
            errors.append(f"{flag}_not_allowed")
    if packet.get("decision") == "ALLOW_PROMOTION_REVIEW" and packet.get("promotion_ready") is not True:
        errors.append("promotion_review_without_ready_flag")
    if packet.get("decision") in {"ACCEPT_CLEAN_ASSET", "SHADOW_TEST"} and packet.get("promotion_ready") is True:
        errors.append("non_promotion_runtime_marked_ready")
    if packet.get("decision") in {"ALLOW_PAPER_ACTIVE_CHALLENGER", "ALLOW_PAPER_PRIMARY"}:
        if packet.get("paper_active_ready") is not True:
            errors.append("paper_runtime_without_ready_flag")
        if permissions.get("can_influence_paper_decision") is not True:
            errors.append("paper_runtime_without_decision_permission")
        if permissions.get("can_write_order") is True:
            errors.append("paper_runtime_must_not_write_orders")
    return errors
