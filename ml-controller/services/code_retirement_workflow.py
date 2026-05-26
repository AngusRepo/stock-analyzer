"""Combined read-only workflow for code retirement evidence."""

from __future__ import annotations

from typing import Any

from services.code_retirement_inventory import build_code_retirement_inventory
from services.code_retirement_planner import build_code_retirement_plan


SCHEMA_VERSION = "code-retirement-report-v1"


def _next_step(plan: dict[str, Any]) -> str:
    summary = plan.get("summary") if isinstance(plan.get("summary"), dict) else {}
    if int(summary.get("delete_ready_count") or 0) > 0:
        return "wei_manual_delete_review"
    if int(summary.get("blocked_count") or 0) > 0:
        return "clear_blockers_before_delete_review"
    return "no_retirement_candidates"


def build_code_retirement_report(
    *,
    adoption_decision_packet: dict[str, Any],
    repo_root: str,
    candidate_paths: list[str] | None = None,
    owner_tokens: list[str] | None = None,
    replacement_owner: str | None = None,
    parallel_readback_passed: bool = False,
    rollback_path: str = "",
) -> dict[str, Any]:
    inventory = build_code_retirement_inventory(
        adoption_decision_packet=adoption_decision_packet,
        repo_root=repo_root,
        candidate_paths=candidate_paths,
        owner_tokens=owner_tokens,
        replacement_owner=replacement_owner,
        parallel_readback_passed=parallel_readback_passed,
        rollback_path=rollback_path,
    )
    plan = build_code_retirement_plan(
        adoption_decision_packet=adoption_decision_packet,
        code_inventory=inventory["items"],
    )
    next_step = _next_step(plan)
    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "retirement_workflow_only",
        "inventory": inventory,
        "retirement_plan": plan,
        "summary": {
            "candidate_count": inventory["summary"]["candidate_count"],
            "reference_count": inventory["summary"]["reference_count"],
            "delete_ready_count": plan["summary"]["delete_ready_count"],
            "blocked_count": plan["summary"]["blocked_count"],
        },
        "filesystem_mutation_allowed": False,
        "destructive_action_executed": False,
        "decision": {
            "ready_for_wei_review": next_step == "wei_manual_delete_review",
            "next_step": next_step,
            "production_mutation_allowed": False,
            "commit_allowed": False,
            "deploy_allowed": False,
            "retrain_allowed": False,
            "trade_allowed": False,
        },
    }
