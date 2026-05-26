"""One-call read-only code retirement review packet."""

from __future__ import annotations

from typing import Any

from services.code_retirement_approval_manifest import build_code_retirement_approval_manifest
from services.code_retirement_profiles import resolve_code_retirement_profile
from services.code_retirement_workflow import build_code_retirement_report


SCHEMA_VERSION = "code-retirement-review-v1"


def _next_step(report: dict[str, Any], manifest: dict[str, Any]) -> str:
    if manifest.get("status") == "blocked":
        return "fix_safety_blockers_before_review"
    if manifest.get("approval_items"):
        return "wei_manual_delete_review"
    summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
    if int(summary.get("blocked_count") or 0) > 0:
        return "clear_blockers_before_delete_review"
    return "no_retirement_candidates"


def _blocked_profile_manifest(profile: dict[str, Any]) -> dict[str, Any]:
    blockers = profile.get("blockers") if isinstance(profile.get("blockers"), list) else []
    return {
        "schema_version": "code-retirement-approval-manifest-v1",
        "decision_effect": "delete_approval_manifest_only",
        "status": "blocked",
        "blockers": blockers,
        "approval_items": [],
        "blocked_items": [],
        "summary": {
            "approval_count": 0,
            "blocked_count": 0,
        },
        "filesystem_mutation_allowed": False,
        "destructive_action_executed": False,
        "decision": {
            "ready_for_wei_review": False,
            "delete_allowed": False,
            "production_mutation_allowed": False,
            "commit_allowed": False,
            "deploy_allowed": False,
            "retrain_allowed": False,
            "trade_allowed": False,
        },
    }


def build_code_retirement_review(
    *,
    adoption_decision_packet: dict[str, Any],
    repo_root: str,
    candidate_paths: list[str] | None = None,
    owner_tokens: list[str] | None = None,
    replacement_owner: str | None = None,
    parallel_readback_passed: bool = False,
    rollback_path: str = "",
    reviewer: str = "Wei",
) -> dict[str, Any]:
    profile = resolve_code_retirement_profile(
        adoption_decision_packet=adoption_decision_packet,
        candidate_paths=candidate_paths,
        owner_tokens=owner_tokens,
        replacement_owner=replacement_owner,
        rollback_path=rollback_path,
    )
    report = build_code_retirement_report(
        adoption_decision_packet=adoption_decision_packet,
        repo_root=repo_root,
        candidate_paths=profile["candidate_paths"],
        owner_tokens=profile["owner_tokens"],
        replacement_owner=profile["replacement_owner"],
        parallel_readback_passed=parallel_readback_passed,
        rollback_path=profile["rollback_path"],
    )
    manifest = build_code_retirement_approval_manifest(
        retirement_report=report,
        reviewer=reviewer,
    )
    profile_blockers = profile.get("blockers") if isinstance(profile.get("blockers"), list) else []
    if profile_blockers:
        manifest = _blocked_profile_manifest(profile)
        next_step = "profile_required_before_retirement_review"
    else:
        next_step = _next_step(report, manifest)
    return {
        "schema_version": SCHEMA_VERSION,
        "decision_effect": "retirement_review_only",
        "profile": profile,
        "retirement_report": report,
        "approval_manifest": manifest,
        "summary": {
            "candidate_count": report["summary"]["candidate_count"],
            "reference_count": report["summary"]["reference_count"],
            "delete_ready_count": report["summary"]["delete_ready_count"],
            "approval_count": manifest["summary"]["approval_count"],
            "blocked_count": manifest["summary"]["blocked_count"],
        },
        "filesystem_mutation_allowed": False,
        "destructive_action_executed": False,
        "decision": {
            "ready_for_wei_review": next_step == "wei_manual_delete_review",
            "next_step": next_step,
            "delete_allowed": False,
            "production_mutation_allowed": False,
            "commit_allowed": False,
            "deploy_allowed": False,
            "retrain_allowed": False,
            "trade_allowed": False,
        },
    }
