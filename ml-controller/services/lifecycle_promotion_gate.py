"""Lifecycle action guard for production promotion.

Model-pool shadow IC decides whether a challenger deserves consideration.
Production promotion still needs the strategy-level gate to pass first.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def apply_promotion_gate_to_actions(
    actions: list[dict[str, Any]],
    gate_result: dict[str, Any] | None,
    *,
    require_gate: bool = True,
    require_shadow_ab: bool = False,
    shadow_ab_by_model: dict[str, dict[str, Any]] | None = None,
    require_paper_order_ab: bool = False,
    paper_order_ab_by_model: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    if not require_gate and not require_shadow_ab and not require_paper_order_ab:
        return actions

    gate = gate_result or {}
    if gate.get("passed") is True and not require_shadow_ab and not require_paper_order_ab:
        return actions

    guarded = deepcopy(actions)
    for action in guarded:
        if action.get("transition") != "promote":
            continue
        original_reason = action.get("reason") or "promote preconditions satisfied"

        if require_gate and gate.get("passed") is not True:
            action["transition"] = "promote_blocked"
            action["reason"] = "production promotion gate failed"
            action["preconditions_failed"] = [
                f"promotion_gate:{name}"
                for name in (gate.get("failed_gates") or ["unavailable"])
            ]
            action["promotion_gate_decision"] = gate.get("decision") or "FAIL"
            action["promotion_gate_failed_gates"] = gate.get("failed_gates") or ["unavailable"]
            action["promotion_gate_warnings"] = gate.get("warnings") or []
            action["original_promote_reason"] = original_reason
            continue

        if require_shadow_ab:
            model = str(action.get("model") or "")
            evidence = (shadow_ab_by_model or {}).get(model)
            if not evidence:
                action["transition"] = "promote_blocked"
                action["reason"] = "shadow AB evidence missing"
                action["preconditions_failed"] = [f"missing_shadow_ab:{model}"]
                action["shadow_ab_decision"] = "FAIL"
                action["original_promote_reason"] = original_reason
                continue
            if str(evidence.get("decision") or "").upper() != "PASS":
                action["transition"] = "promote_blocked"
                action["reason"] = "shadow AB evidence failed"
                action["preconditions_failed"] = [
                    f"shadow_ab:{name}"
                    for name in (evidence.get("failed_gates") or ["unavailable"])
                ]
                action["shadow_ab_decision"] = evidence.get("decision") or "FAIL"
                action["shadow_ab_evidence"] = evidence
                action["original_promote_reason"] = original_reason
                continue

        if require_paper_order_ab:
            model = str(action.get("model") or "")
            evidence = (paper_order_ab_by_model or {}).get(model)
            if not evidence:
                action["transition"] = "promote_blocked"
                action["reason"] = "paper-order AB evidence missing"
                action["preconditions_failed"] = [f"missing_paper_order_ab:{model}"]
                action["paper_order_ab_decision"] = "FAIL"
                action["original_promote_reason"] = original_reason
                continue
            if str(evidence.get("decision") or "").upper() != "PASS":
                action["transition"] = "promote_blocked"
                action["reason"] = "paper-order AB evidence failed"
                action["preconditions_failed"] = [
                    f"paper_order_ab:{name}"
                    for name in (evidence.get("failed_gates") or ["unavailable"])
                ]
                action["paper_order_ab_decision"] = evidence.get("decision") or "FAIL"
                action["paper_order_ab_evidence"] = evidence
                action["original_promote_reason"] = original_reason
    return guarded
