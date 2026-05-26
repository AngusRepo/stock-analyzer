"""Manual approval manifest for code retirement candidates.

This service is read-only. It produces review evidence for Wei; it never grants
automatic deletion permission or emits destructive commands.
"""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "code-retirement-approval-manifest-v1"


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _clean_text(value: object, default: str = "") -> str:
    text = str(value or "").strip()
    return text or default


def _upstream_safety_blockers(report: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if bool(report.get("filesystem_mutation_allowed")):
        blockers.append("upstream_report_mutation_flag_invalid")
    if bool(report.get("destructive_action_executed")):
        blockers.append("upstream_destructive_action_detected")
    decision = _as_dict(report.get("decision"))
    if bool(decision.get("production_mutation_allowed")):
        blockers.append("upstream_decision_mutation_flag_invalid")
    return blockers


def _approval_item(item: dict[str, Any], reviewer: str) -> dict[str, Any]:
    return {
        "path": _clean_text(item.get("path"), "unknown"),
        "owner": _clean_text(item.get("owner"), "unknown"),
        "replacement_owner": _clean_text(item.get("replacement_owner"), "unknown"),
        "rollback_path": _clean_text(item.get("rollback_path")),
        "runtime_references": int(item.get("runtime_references") or 0),
        "reference_paths": item.get("reference_paths") if isinstance(item.get("reference_paths"), list) else [],
        "required_approvals": ["wei_manual_approval"],
        "reviewer": _clean_text(reviewer, "Wei"),
        "approval_status": "awaiting_wei_approval",
        "delete_allowed": False,
    }


def _blocked_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": _clean_text(item.get("path"), "unknown"),
        "action": _clean_text(item.get("action"), "unknown"),
        "blockers": item.get("blockers") if isinstance(item.get("blockers"), list) else [],
    }


def build_code_retirement_approval_manifest(
    *,
    retirement_report: dict[str, Any],
    reviewer: str = "Wei",
) -> dict[str, Any]:
    retirement_report = _as_dict(retirement_report)
    safety_blockers = _upstream_safety_blockers(retirement_report)
    plan = _as_dict(retirement_report.get("retirement_plan"))
    plan_items = plan.get("items") if isinstance(plan.get("items"), list) else []

    approval_items: list[dict[str, Any]] = []
    blocked_items: list[dict[str, Any]] = []
    if not safety_blockers:
        for item in plan_items:
            if not isinstance(item, dict):
                continue
            if item.get("action") == "delete_ready_after_wei_approval" and not item.get("blockers"):
                approval_items.append(_approval_item(item, reviewer))
            else:
                blocked_items.append(_blocked_item(item))

    status = "blocked" if safety_blockers else "ready_for_review"
    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "delete_approval_manifest_only",
        "status": status,
        "blockers": safety_blockers,
        "approval_items": approval_items,
        "blocked_items": blocked_items,
        "summary": {
            "approval_count": len(approval_items),
            "blocked_count": len(blocked_items),
        },
        "filesystem_mutation_allowed": False,
        "destructive_action_executed": False,
        "decision": {
            "ready_for_wei_review": bool(approval_items) and not safety_blockers,
            "delete_allowed": False,
            "production_mutation_allowed": False,
            "commit_allowed": False,
            "deploy_allowed": False,
            "retrain_allowed": False,
            "trade_allowed": False,
        },
    }
