import asyncio
from pathlib import Path

from routers.research_benchmark import (
    CodeRetirementReviewRequest,
    research_code_retirement_review_dry_run,
)
from services.code_retirement_review import build_code_retirement_review


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


def test_code_retirement_review_runs_inventory_plan_and_manifest_for_clean_candidate():
    review = build_code_retirement_review(
        adoption_decision_packet=_replace_packet(),
        repo_root=str(FIXTURES / "no_refs"),
        candidate_paths=["services/obsolete_rank_score.py"],
        owner_tokens=["obsolete_rank_score"],
        parallel_readback_passed=True,
        rollback_path="services/portfolio_allocation.py",
        reviewer="Wei",
    )

    assert review["schema_version"] == "code-retirement-review-v1"
    assert review["decision_effect"] == "retirement_review_only"
    assert review["retirement_report"]["summary"]["delete_ready_count"] == 1
    assert review["approval_manifest"]["summary"]["approval_count"] == 1
    assert review["decision"]["next_step"] == "wei_manual_delete_review"
    assert review["decision"]["delete_allowed"] is False
    assert review["filesystem_mutation_allowed"] is False
    assert review["destructive_action_executed"] is False


def test_code_retirement_review_keeps_blocked_candidates_out_of_approval_manifest():
    review = build_code_retirement_review(
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

    assert review["retirement_report"]["summary"]["blocked_count"] == 1
    assert review["approval_manifest"]["approval_items"] == []
    assert review["approval_manifest"]["blocked_items"][0]["path"] == "services/predict_then_optimize.py"
    assert review["decision"]["next_step"] == "clear_blockers_before_delete_review"
    assert review["decision"]["ready_for_wei_review"] is False


def test_code_retirement_review_route_is_non_mutating():
    response = asyncio.run(research_code_retirement_review_dry_run(
        CodeRetirementReviewRequest(
            adoption_decision_packet=_replace_packet(),
            repo_root=str(FIXTURES / "no_refs"),
            candidate_paths=["services/obsolete_rank_score.py"],
            owner_tokens=["obsolete_rank_score"],
            parallel_readback_passed=True,
            rollback_path="services/portfolio_allocation.py",
            reviewer="Wei",
        )
    ))

    assert response["decision_effect"] == "retirement_review_only"
    assert response["decision"]["production_mutation_allowed"] is False
    assert response["decision"]["delete_allowed"] is False


def test_code_retirement_review_uses_registry_profile_when_inputs_are_omitted():
    review = build_code_retirement_review(
        adoption_decision_packet=_replace_packet(
            candidate_id="sparse-tangent-v1",
            baseline_id="rank_topk_equal_weight",
        ),
        repo_root=str(FIXTURES / "auto_discover"),
        parallel_readback_passed=True,
    )

    item = review["retirement_report"]["retirement_plan"]["items"][0]
    assert review["profile"]["source"] == "registry"
    assert "rank_topk" in review["profile"]["owner_tokens"]
    assert review["retirement_report"]["inventory"]["summary"]["candidate_count"] == 1
    assert item["path"] == "services/rank_topk_allocator.py"
    assert item["rollback_path"] == "ml-controller/services/portfolio_allocation.py"
    assert review["decision"]["next_step"] == "clear_blockers_before_delete_review"


def test_code_retirement_review_explicit_inputs_override_registry_profile():
    review = build_code_retirement_review(
        adoption_decision_packet=_replace_packet(
            candidate_id="sparse-tangent-v1",
            baseline_id="rank_topk_equal_weight",
        ),
        repo_root=str(FIXTURES / "no_refs"),
        owner_tokens=["obsolete_rank_score"],
        rollback_path="custom/rollback.py",
        parallel_readback_passed=True,
    )

    item = review["retirement_report"]["retirement_plan"]["items"][0]
    assert review["profile"]["source"] == "registry"
    assert review["profile"]["owner_tokens"] == ["obsolete_rank_score"]
    assert sorted(review["profile"]["overrides"]) == ["owner_tokens", "rollback_path"]
    assert item["path"] == "services/obsolete_rank_score.py"
    assert item["rollback_path"] == "custom/rollback.py"
    assert review["decision"]["next_step"] == "wei_manual_delete_review"


def test_code_retirement_review_blocks_unknown_baseline_without_explicit_profile_inputs():
    review = build_code_retirement_review(
        adoption_decision_packet=_replace_packet(
            candidate_id="new-model-v1",
            baseline_id="unknown_legacy_alpha",
        ),
        repo_root=str(FIXTURES / "no_refs"),
        parallel_readback_passed=True,
    )

    assert review["profile"]["source"] == "fallback"
    assert "profile_registry_missing" in review["profile"]["blockers"]
    assert "rollback_path_missing_for_fallback_profile" in review["profile"]["blockers"]
    assert review["decision"]["next_step"] == "profile_required_before_retirement_review"
    assert review["decision"]["ready_for_wei_review"] is False
    assert review["approval_manifest"]["approval_items"] == []


def test_code_retirement_review_allows_unknown_baseline_with_explicit_profile_inputs():
    review = build_code_retirement_review(
        adoption_decision_packet=_replace_packet(
            candidate_id="new-model-v1",
            baseline_id="unknown_legacy_alpha",
        ),
        repo_root=str(FIXTURES / "no_refs"),
        owner_tokens=["obsolete_rank_score"],
        rollback_path="custom/rollback.py",
        parallel_readback_passed=True,
    )

    assert review["profile"]["source"] == "fallback"
    assert review["profile"]["blockers"] == []
    assert sorted(review["profile"]["overrides"]) == ["owner_tokens", "rollback_path"]
    assert review["approval_manifest"]["summary"]["approval_count"] == 1
    assert review["decision"]["next_step"] == "wei_manual_delete_review"
