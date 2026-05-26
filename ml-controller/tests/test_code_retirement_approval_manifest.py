import asyncio
from pathlib import Path

from routers.research_benchmark import (
    CodeRetirementApprovalManifestRequest,
    research_code_retirement_approval_manifest_dry_run,
)
from services.code_retirement_approval_manifest import build_code_retirement_approval_manifest
from services.code_retirement_workflow import build_code_retirement_report


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "ml-controller" / "tests" / "fixtures" / "code_retirement_inventory"


def _replace_packet(
    *,
    candidate_id: str = "sparse-tangent-v1",
    baseline_id: str = "obsolete_rank_score",
):
    return {
        "candidate_id": candidate_id,
        "baseline_id": baseline_id,
        "baseline_retirement": {
            "status": "retirement_candidate",
            "target": baseline_id,
        },
        "decision": {
            "action": "replace",
            "ready_for_wei_review": True,
            "production_mutation_allowed": False,
        },
    }


def _clean_report():
    return build_code_retirement_report(
        adoption_decision_packet=_replace_packet(),
        repo_root=str(FIXTURES / "no_refs"),
        candidate_paths=["services/obsolete_rank_score.py"],
        owner_tokens=["obsolete_rank_score"],
        parallel_readback_passed=True,
        rollback_path="services/portfolio_allocation.py",
    )


def test_code_retirement_approval_manifest_lists_only_delete_ready_items():
    manifest = build_code_retirement_approval_manifest(
        retirement_report=_clean_report(),
        reviewer="Wei",
    )

    item = manifest["approval_items"][0]
    assert manifest["schema_version"] == "code-retirement-approval-manifest-v1"
    assert manifest["decision_effect"] == "delete_approval_manifest_only"
    assert item["path"] == "services/obsolete_rank_score.py"
    assert item["approval_status"] == "awaiting_wei_approval"
    assert item["rollback_path"] == "services/portfolio_allocation.py"
    assert manifest["decision"]["ready_for_wei_review"] is True
    assert manifest["decision"]["delete_allowed"] is False
    assert manifest["destructive_action_executed"] is False


def test_code_retirement_approval_manifest_keeps_blocked_items_out_of_approvals():
    blocked_report = build_code_retirement_report(
        adoption_decision_packet=_replace_packet(
            candidate_id="signature-transformer-v1",
            baseline_id="predict_then_optimize",
        ),
        repo_root=str(FIXTURES / "runtime_refs"),
        candidate_paths=["services/predict_then_optimize.py"],
        owner_tokens=["predict_then_optimize"],
        parallel_readback_passed=True,
        rollback_path="services/direct_allocation_benchmark.py",
    )

    manifest = build_code_retirement_approval_manifest(retirement_report=blocked_report)

    assert manifest["approval_items"] == []
    assert manifest["blocked_items"][0]["path"] == "services/predict_then_optimize.py"
    assert "runtime_references_still_present" in manifest["blocked_items"][0]["blockers"]
    assert manifest["decision"]["ready_for_wei_review"] is False


def test_code_retirement_approval_manifest_blocks_mutating_upstream_reports():
    report = _clean_report()
    report["filesystem_mutation_allowed"] = True

    manifest = build_code_retirement_approval_manifest(retirement_report=report)

    assert manifest["status"] == "blocked"
    assert "upstream_report_mutation_flag_invalid" in manifest["blockers"]
    assert manifest["approval_items"] == []


def test_code_retirement_approval_manifest_route_is_non_mutating():
    response = asyncio.run(research_code_retirement_approval_manifest_dry_run(
        CodeRetirementApprovalManifestRequest(
            retirement_report=_clean_report(),
            reviewer="Wei",
        )
    ))

    assert response["decision_effect"] == "delete_approval_manifest_only"
    assert response["filesystem_mutation_allowed"] is False
    assert response["destructive_action_executed"] is False
