import asyncio
from pathlib import Path

from routers.research_benchmark import (
    CodeRetirementReportRequest,
    research_code_retirement_report_dry_run,
)
from services.code_retirement_workflow import build_code_retirement_report


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "ml-controller" / "tests" / "fixtures" / "code_retirement_inventory"


def _replace_packet(
    *,
    candidate_id: str = "signature-transformer-v1",
    baseline_id: str = "predict_then_optimize",
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


def test_code_retirement_report_combines_inventory_and_planner_blockers():
    report = build_code_retirement_report(
        adoption_decision_packet=_replace_packet(),
        repo_root=str(FIXTURES / "runtime_refs"),
        candidate_paths=["services/predict_then_optimize.py"],
        owner_tokens=["predict_then_optimize"],
        parallel_readback_passed=True,
        rollback_path="services/direct_allocation_benchmark.py",
    )

    item = report["retirement_plan"]["items"][0]
    assert report["schema_version"] == "code-retirement-report-v1"
    assert report["decision_effect"] == "retirement_workflow_only"
    assert report["inventory"]["summary"]["candidate_count"] == 1
    assert item["action"] == "keep_until_readback"
    assert "runtime_references_still_present" in item["blockers"]
    assert report["decision"]["next_step"] == "clear_blockers_before_delete_review"
    assert report["destructive_action_executed"] is False


def test_code_retirement_report_marks_manual_delete_review_when_clean():
    report = build_code_retirement_report(
        adoption_decision_packet=_replace_packet(
            candidate_id="sparse-tangent-v1",
            baseline_id="obsolete_rank_score",
        ),
        repo_root=str(FIXTURES / "no_refs"),
        candidate_paths=["services/obsolete_rank_score.py"],
        owner_tokens=["obsolete_rank_score"],
        parallel_readback_passed=True,
        rollback_path="services/portfolio_allocation.py",
    )

    item = report["retirement_plan"]["items"][0]
    assert item["action"] == "delete_ready_after_wei_approval"
    assert report["decision"]["ready_for_wei_review"] is True
    assert report["decision"]["next_step"] == "wei_manual_delete_review"
    assert report["decision"]["production_mutation_allowed"] is False


def test_code_retirement_report_route_is_non_mutating():
    response = asyncio.run(research_code_retirement_report_dry_run(
        CodeRetirementReportRequest(
            adoption_decision_packet=_replace_packet(),
            repo_root=str(FIXTURES / "runtime_refs"),
            candidate_paths=["services/predict_then_optimize.py"],
            owner_tokens=["predict_then_optimize"],
            parallel_readback_passed=True,
            rollback_path="services/direct_allocation_benchmark.py",
        )
    ))

    assert response["decision_effect"] == "retirement_workflow_only"
    assert response["filesystem_mutation_allowed"] is False
    assert response["destructive_action_executed"] is False
