"""Research-only code retirement planner.

This planner converts an accepted adoption decision into a review checklist for
removing obsolete code. It never deletes files or mutates runtime state.
"""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "code-retirement-plan-v1"


def _clean_text(value: object, default: str = "") -> str:
    text = str(value or "").strip()
    return text or default


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_int(value: object) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _adoption_allows_retirement(packet: dict[str, Any]) -> tuple[bool, list[str]]:
    decision = _as_dict(packet.get("decision"))
    retirement = _as_dict(packet.get("baseline_retirement"))
    blockers: list[str] = []

    if bool(decision.get("production_mutation_allowed")):
        blockers.append("upstream_report_mutation_flag_invalid")
    if _clean_text(decision.get("action")) != "replace":
        blockers.append("adoption_action_does_not_retire_baseline")
    if _clean_text(retirement.get("status")) != "retirement_candidate":
        blockers.append("baseline_not_marked_retirement_candidate")

    return not blockers, blockers


def _inventory_item_plan(
    item: dict[str, Any],
    *,
    adoption_packet: dict[str, Any],
    retirement_allowed: bool,
    adoption_blockers: list[str],
) -> dict[str, Any]:
    decision = _as_dict(adoption_packet.get("decision"))
    retirement = _as_dict(adoption_packet.get("baseline_retirement"))
    candidate_id = _clean_text(adoption_packet.get("candidate_id"))
    target_owner = _clean_text(retirement.get("target"), _clean_text(adoption_packet.get("baseline_id"), "unknown"))

    path = _clean_text(item.get("path"), "unknown")
    owner = _clean_text(item.get("owner"), "unknown")
    replacement_owner = _clean_text(item.get("replacement_owner"))
    runtime_references = _safe_int(item.get("runtime_references"))
    blockers = list(adoption_blockers)

    if owner != target_owner:
        blockers.append("inventory_owner_not_retirement_target")
    if replacement_owner != candidate_id:
        blockers.append("replacement_owner_mismatch")
    if not bool(item.get("parallel_readback_passed")):
        blockers.append("parallel_readback_missing")
    if runtime_references > 0:
        blockers.append("runtime_references_still_present")
    if not _clean_text(item.get("rollback_path")):
        blockers.append("rollback_path_missing")
    if path == "unknown":
        blockers.append("path_missing")

    if not retirement_allowed:
        action = "keep"
    elif blockers:
        action = "keep_until_readback"
    else:
        action = "delete_ready_after_wei_approval"

    return {
        "path": path,
        "owner": owner,
        "replacement_owner": replacement_owner,
        "retirement_target": target_owner,
        "runtime_references": runtime_references,
        "parallel_readback_passed": bool(item.get("parallel_readback_passed")),
        "rollback_path": _clean_text(item.get("rollback_path")),
        "action": action,
        "blockers": blockers,
        "decision_context": {
            "adoption_action": _clean_text(decision.get("action"), "unknown"),
            "baseline_retirement_status": _clean_text(retirement.get("status"), "unknown"),
        },
    }


def build_code_retirement_plan(
    *,
    adoption_decision_packet: dict[str, Any],
    code_inventory: list[dict[str, Any]],
) -> dict[str, Any]:
    adoption_decision_packet = _as_dict(adoption_decision_packet)
    code_inventory = [item for item in code_inventory if isinstance(item, dict)]
    retirement_allowed, adoption_blockers = _adoption_allows_retirement(adoption_decision_packet)

    items = [
        _inventory_item_plan(
            item,
            adoption_packet=adoption_decision_packet,
            retirement_allowed=retirement_allowed,
            adoption_blockers=adoption_blockers,
        )
        for item in code_inventory
    ]
    delete_ready_count = sum(1 for item in items if item["action"] == "delete_ready_after_wei_approval")
    blocked_count = sum(1 for item in items if item["blockers"])

    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "retirement_plan_only",
        "candidate_id": _clean_text(adoption_decision_packet.get("candidate_id")),
        "baseline_id": _clean_text(adoption_decision_packet.get("baseline_id")),
        "items": items,
        "summary": {
            "inventory_count": len(items),
            "delete_ready_count": delete_ready_count,
            "blocked_count": blocked_count,
        },
        "filesystem_mutation_allowed": False,
        "destructive_action_executed": False,
        "requires_wei_approval": True,
        "decision": {
            "ready_for_wei_review": delete_ready_count > 0,
            "production_mutation_allowed": False,
            "commit_allowed": False,
            "deploy_allowed": False,
            "retrain_allowed": False,
            "trade_allowed": False,
        },
    }
